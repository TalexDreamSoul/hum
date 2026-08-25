import "server-only";

import { spawn } from "node:child_process";
import { analyze } from "../analysis/engine";
import { buildLyricsTimeline, type LyricLineTiming } from "../analysis/lyrics-timeline";
import type { SceneKey } from "../analysis/score";
import type { CandidateAudioProbe } from "./candidates";

const ANALYZER_VERSION = "hum-dsp-2";
const ANALYSIS_SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = ANALYSIS_SAMPLE_RATE * 600 * Float32Array.BYTES_PER_ELEMENT;
const MIN_PASS_SCORE = 70;

export interface CandidateAutoAssessment {
  passed: boolean;
  notes: string;
  scores: {
    analyzerVersion: string;
    minimumPassScore: number;
    total: number | null;
    grade: "A" | "B" | "C" | "D" | null;
    scene: SceneKey;
    dims: Array<{ key: string; label: string; weight: number; score: number | null; detail: string }>;
    findings: Array<{ tone: "good" | "warn" | "bad" | "info"; text: string }>;
    probe: CandidateAudioProbe;
    /** 用留白检测反推的逐行时间轴，报告页拿它做歌词跟随和 .lrc 导出 */
    lyricsTimeline: LyricLineTiming[];
  };
}

async function decodeMonoPcm(file: string, signal: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-i", file,
      "-t", "600",
      "-ac", "1",
      "-ar", String(ANALYSIS_SAMPLE_RATE),
      "-f", "f32le",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"], signal });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    let errorTotal = 0;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_PCM_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorTotal >= 16_384) return;
      errors.push(chunk);
      errorTotal += chunk.byteLength;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (total > MAX_PCM_BYTES) {
        reject(new Error("候选音频解码结果超过 600 秒分析上限"));
        return;
      }
      if (code !== 0 || total === 0 || total % Float32Array.BYTES_PER_ELEMENT !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim().slice(0, 500);
        reject(new Error(detail ? `ffmpeg 解码失败：${detail}` : "ffmpeg 未返回可分析音频"));
        return;
      }
      const pcm = Buffer.concat(chunks, total);
      resolve(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / Float32Array.BYTES_PER_ELEMENT));
    });
  });
}

export async function assessCandidateAudio(
  file: string,
  scene: SceneKey,
  probe: CandidateAudioProbe,
  signal: AbortSignal,
  lyrics = "",
  targetDurationSec?: number,
): Promise<CandidateAutoAssessment> {
  if (!probe.passed) {
    return {
      passed: false,
      notes: probe.failures.join("；"),
      scores: {
        analyzerVersion: ANALYZER_VERSION,
        minimumPassScore: MIN_PASS_SCORE,
        total: null,
        grade: null,
        scene,
        dims: [],
        findings: probe.failures.map((text) => ({ tone: "bad" as const, text })),
        probe,
        lyricsTimeline: [],
      },
    };
  }

  const samples = await decodeMonoPcm(file, signal);
  const report = await analyze(file, [samples], ANALYSIS_SAMPLE_RATE, scene, undefined, targetDurationSec);
  const passed = report.score.total >= MIN_PASS_SCORE;
  const relevantFindings = report.score.findings.filter((finding) => finding.tone === "bad" || finding.tone === "warn");
  return {
    passed,
    notes: passed
      ? `自动评分 ${report.score.total}（${report.score.grade}），达到 ${MIN_PASS_SCORE} 分门槛`
      : [`自动评分 ${report.score.total}（${report.score.grade}），低于 ${MIN_PASS_SCORE} 分门槛`, ...relevantFindings.map((finding) => finding.text)].join("；"),
    scores: {
      analyzerVersion: ANALYZER_VERSION,
      minimumPassScore: MIN_PASS_SCORE,
      total: report.score.total,
      grade: report.score.grade,
      scene: report.score.scene,
      dims: report.score.dims,
      findings: report.score.findings,
      probe,
      lyricsTimeline: buildLyricsTimeline(lyrics, report.gaps.durationSec, report.gaps.spans),
    },
  };
}
