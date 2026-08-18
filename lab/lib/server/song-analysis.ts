import "server-only";

import { randomUUID } from "node:crypto";
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
import type { JobTracker } from "./jobs";
import { createQiniuObjectUrl } from "./qiniu";
import { saveSongEvaluation } from "./reports";
import { dispatchPendingNotifications, enqueueNotificationEvent, type NotificationEvent } from "./notifications";

const MAX_ANALYSIS_BYTES = 500 * 1024 * 1024;

export async function analyzeUploadedSong(songId: string, signal: AbortSignal, job?: JobTracker): Promise<string> {
  const database = getDb();
  const song = await database.prepare(`
    SELECT id, object_key, original_name, size_bytes, analysis_scene
    FROM songs WHERE id = ?
  `).get(songId) as {
    id: string;
    object_key: string;
    original_name: string;
    size_bytes: number;
    analysis_scene: SceneKey;
  } | undefined;
  if (!song) throw new ApiError(404, "待分析歌曲不存在");
  if (song.size_bytes > MAX_ANALYSIS_BYTES) throw new ApiError(413, "音频超过 500MB 分析上限");

  await database.prepare("UPDATE songs SET status = 'analyzing', updated_at = ? WHERE id = ?").run(Date.now(), songId);
  const directory = path.join(getDataDir(), "analysis-tmp", randomUUID());
  const file = path.join(directory, "input-audio");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    job?.artifact("下载", "fields", "私有音频下载", { fields: [{ label: "文件", value: song.original_name }, { label: "大小", value: `${song.size_bytes} bytes` }] });
    const response = await fetch(await createQiniuObjectUrl(song.object_key, 15 * 60), { signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new ApiError(502, `下载七牛音频失败（HTTP ${response.status}）`);
    let downloaded = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.byteLength;
        if (downloaded > MAX_ANALYSIS_BYTES) callback(new ApiError(413, "下载音频超过 500MB 分析上限"));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(file, { mode: 0o600 }));
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
      await transaction.prepare("UPDATE songs SET status = 'analyzed', updated_at = ? WHERE id = ?").run(Date.now(), songId);
    })();
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
    await database.prepare("UPDATE songs SET status = 'uploaded', updated_at = ? WHERE id = ?").run(Date.now(), songId).catch(() => undefined);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
