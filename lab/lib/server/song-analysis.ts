import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SceneKey } from "../analysis/score";
import { ApiError } from "./api";
import { assessCandidateAudio } from "./candidate-analysis";
import { probeAudio } from "./candidates";
import { getDataDir } from "./data-dir";
import { getDb } from "./database";
import { beginSongMediaAnalysis, markSongMediaAnalysisFailed, syncSongMediaAnalysis } from "./media";
import type { JobTracker } from "./jobs";
import { createQiniuObjectUrl } from "./qiniu";
import { saveSongEvaluation } from "./reports";
import { dispatchPendingNotifications, enqueueNotificationEvent, type NotificationEvent } from "./notifications";

const MAX_ANALYSIS_BYTES = 500 * 1024 * 1024;

export async function analyzeUploadedSong(songId: string, signal: AbortSignal, job?: JobTracker): Promise<string> {
  const database = getDb();
  const song = await database.prepare(`
    SELECT id, object_key, original_name, size_bytes, analysis_scene, status
    FROM songs WHERE id = ?
  `).get(songId) as {
    id: string;
    object_key: string;
    original_name: string;
    size_bytes: number;
    analysis_scene: SceneKey;
    status: string;
  } | undefined;
  if (!song) throw new ApiError(404, "待分析歌曲不存在");
  if (!['uploaded', 'queued'].includes(song.status)) throw new ApiError(409, "歌曲不在可分析状态");
  if (!await beginSongMediaAnalysis(songId)) throw new ApiError(409, "媒体不在可分析状态");

  const directory = path.join(getDataDir(), "analysis-tmp", randomUUID());
  const file = path.join(directory, "input-audio");
  let analysisPersisted = false;
  let trustedContentHash: string | undefined;
  let mediaFailureReason = "音频技术元数据提取失败";
  try {
    const songClaim = await database.prepare(`
      UPDATE songs SET status = 'analyzing', updated_at = ?
      WHERE id = ? AND status IN ('uploaded', 'queued')
    `).run(Date.now(), songId);
    if (!songClaim.changes) throw new ApiError(409, "歌曲不在可分析状态");
    if (song.size_bytes > MAX_ANALYSIS_BYTES) {
      mediaFailureReason = "音频超过分析上限";
      throw new ApiError(413, "音频超过 500MB 分析上限");
    }

    await mkdir(directory, { recursive: true, mode: 0o700 });
    job?.artifact("下载", "fields", "私有音频下载", { fields: [{ label: "文件", value: song.original_name }, { label: "大小", value: `${song.size_bytes} bytes` }] });
    const response = await fetch(await createQiniuObjectUrl(song.object_key, 15 * 60), { signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new ApiError(502, `下载七牛音频失败（HTTP ${response.status}）`);
    let downloaded = 0;
    const digest = createHash("sha256");
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.byteLength;
        if (downloaded > MAX_ANALYSIS_BYTES) {
          mediaFailureReason = "下载音频超过分析上限";
          callback(new ApiError(413, "下载音频超过 500MB 分析上限"));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(file, { mode: 0o600 }));
    trustedContentHash = digest.digest("hex");
    const probe = await probeAudio(file, downloaded);
    job?.artifact("探测", "fields", "音频元数据", {
      fields: [
        { label: "文件", value: song.original_name },
        { label: "大小", value: `${downloaded} bytes` },
        { label: "时长", value: `${probe.durationSec.toFixed(1)} 秒` },
        { label: "采样率", value: `${probe.sampleRate} Hz` },
        { label: "声道", value: String(probe.channels) },
      ],
    });
    if (!probe.passed) {
      mediaFailureReason = "音频技术元数据校验失败";
      throw new ApiError(422, mediaFailureReason);
    }

    mediaFailureReason = "音频自动评分失败";
    const assessment = await assessCandidateAudio(file, song.analysis_scene, probe, signal);
    let reportId = "";
    const reportEvent: NotificationEvent = !assessment.passed
      ? "report.failed"
      : (assessment.scores.total ?? 0) >= 85 ? "report.high_score" : "report.completed";
    await database.transaction(async (transaction) => {
      reportId = await saveSongEvaluation(transaction, songId, assessment);
      await enqueueNotificationEvent(transaction, `report:${reportId}:created`, reportEvent, {
        title: "上传歌曲评分报告已生成",
        status: assessment.passed ? ((assessment.scores.total ?? 0) >= 85 ? "高分" : "已完成") : "不合格",
        detail: assessment.notes,
        score: assessment.scores.total,
        grade: assessment.scores.grade,
        subjectId: songId,
        path: "/console/reports",
      });
      await transaction.prepare("UPDATE songs SET status = 'analyzed', updated_at = ? WHERE id = ? AND status = 'analyzing'").run(Date.now(), songId);
    })();
    await syncSongMediaAnalysis({
      songId,
      durationSec: probe.durationSec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      analyzedSizeBytes: downloaded,
      trustedContentHash,
      reportId,
      passed: assessment.passed,
      total: assessment.scores.total,
      analyzerVersion: assessment.scores.analyzerVersion,
      notes: assessment.notes,
    });
    analysisPersisted = true;
    await dispatchPendingNotifications().catch(() => undefined);
    job?.artifact("评分", "scores", "自动 ReportCard", {
      total: assessment.scores.total,
      grade: assessment.scores.grade,
      threshold: assessment.scores.minimumPassScore,
      passed: assessment.passed,
      dims: assessment.scores.dims,
    });
    job?.setOutput({ songId, reportId, passed: assessment.passed, total: assessment.scores.total });
    job?.step(assessment.notes);
    return reportId;
  } catch (error) {
    if (!analysisPersisted) {
      await database.prepare("UPDATE songs SET status = 'uploaded', updated_at = ? WHERE id = ? AND status = 'analyzing'").run(Date.now(), songId).catch(() => undefined);
      await markSongMediaAnalysisFailed(songId, mediaFailureReason, trustedContentHash).catch(() => undefined);
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "音频分析失败");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
