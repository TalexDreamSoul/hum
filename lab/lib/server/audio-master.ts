import "server-only";

import { spawn } from "node:child_process";
import { rename, unlink } from "node:fs/promises";

/**
 * 候选落盘后的统一后处理：EBU R128 响度归一 + 真峰值限幅。
 *
 * MiniMax 出的母带真峰值恒定顶到 +2 dBTP 以上，靠提示词让模型"留 1 dB 余量"完全无效，
 * 实测四轮响度维一动不动。这一步用 ffmpeg 两遍 loudnorm 把它拉到场景目标，
 * 顺带把真峰值压到 −1.5 dBTP，转码到蓝牙/AAC 不再削波。
 */

export const MASTER_VERSION = "hum-master-1";

export interface MasterMeasurement {
  lufs: number | null;
  truePeak: number | null;
  lra: number | null;
}

export interface MasterResult {
  applied: boolean;
  before: MasterMeasurement;
  after: MasterMeasurement;
  targetLufs: number;
  targetTruePeak: number;
  note: string;
}

const TARGET_TRUE_PEAK = -1.5;

function runFfmpeg(args: string[], signal: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (size > 256_000) return;
      chunks.push(chunk);
      size += chunk.byteLength;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** 第一遍只测量，拿到 loudnorm 的输入统计。 */
function parseLoudnormJson(stderr: string): Record<string, string> | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch {
    return null;
  }
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function masterAudioFile(
  file: string,
  targetLufs: number,
  signal: AbortSignal,
): Promise<MasterResult> {
  const filter = `loudnorm=I=${targetLufs}:TP=${TARGET_TRUE_PEAK}:LRA=9`;
  const measured = await runFfmpeg([
    "-v", "info", "-nostats", "-i", file,
    "-af", `${filter}:print_format=json`,
    "-f", "null", "-",
  ], signal);
  const stats = parseLoudnormJson(measured.stderr);
  const before: MasterMeasurement = {
    lufs: num(stats?.input_i),
    truePeak: num(stats?.input_tp),
    lra: num(stats?.input_lra),
  };

  if (measured.code !== 0 || !stats) {
    return {
      applied: false,
      before,
      after: before,
      targetLufs,
      targetTruePeak: TARGET_TRUE_PEAK,
      note: "ffmpeg 测量失败，保留原始音频",
    };
  }

  // 第二遍带上实测值做线性归一，比单遍动态压缩更忠实
  const linear = [
    filter,
    `measured_I=${stats.input_i}`,
    `measured_TP=${stats.input_tp}`,
    `measured_LRA=${stats.input_lra}`,
    `measured_thresh=${stats.input_thresh}`,
    `offset=${stats.target_offset ?? 0}`,
    "linear=true",
    "print_format=json",
  ].join(":");

  const temp = `${file}.mastered.mp3`;
  const applied = await runFfmpeg([
    "-v", "info", "-nostats", "-y", "-i", file,
    "-af", linear,
    "-c:a", "libmp3lame", "-b:a", "256k", "-ar", "44100",
    temp,
  ], signal);

  if (applied.code !== 0) {
    await unlink(temp).catch(() => undefined);
    return {
      applied: false,
      before,
      after: before,
      targetLufs,
      targetTruePeak: TARGET_TRUE_PEAK,
      note: "ffmpeg 归一失败，保留原始音频",
    };
  }

  const appliedStats = parseLoudnormJson(applied.stderr);
  await rename(temp, file);
  return {
    applied: true,
    before,
    after: {
      lufs: num(appliedStats?.output_i) ?? targetLufs,
      truePeak: num(appliedStats?.output_tp) ?? TARGET_TRUE_PEAK,
      lra: num(appliedStats?.output_lra),
    },
    targetLufs,
    targetTruePeak: TARGET_TRUE_PEAK,
    note: `${MASTER_VERSION}：两遍 loudnorm 线性归一到 ${targetLufs} LUFS / ${TARGET_TRUE_PEAK} dBTP`,
  };
}
