import "server-only";

import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ApiError } from "./api";
import { getDataDir } from "./data-dir";
import { sha256 } from "./song-specs";

const execFileAsync = promisify(execFile);
const MAX_CANDIDATE_BYTES = 50 * 1024 * 1024;

export interface CandidateAudioProbe {
  durationSec: number;
  sampleRate: number;
  channels: number;
  sizeBytes: number;
  passed: boolean;
  failures: string[];
}

export interface PersistedCandidateAudio {
  relativePath: string;
  absolutePath: string;
  outputHash: string;
  probe: CandidateAudioProbe;
}

function candidateRoot(): string {
  return path.join(getDataDir(), "candidates");
}

export function resolveCandidateArtifact(relativePath: string): string {
  const root = candidateRoot();
  const absolute = path.resolve(getDataDir(), relativePath);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new ApiError(500, "候选文件路径越界");
  return absolute;
}

export async function probeAudio(file: string, expectedSize: number): Promise<CandidateAudioProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=sample_rate,channels",
    "-of", "json",
    file,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ sample_rate?: string; channels?: number }>;
  };
  const audioStream = parsed.streams?.find((stream) => stream.sample_rate || stream.channels);
  const durationSec = Number(parsed.format?.duration ?? 0);
  const sampleRate = Number(audioStream?.sample_rate ?? 0);
  const channels = Number(audioStream?.channels ?? 0);
  const sizeBytes = Number(parsed.format?.size ?? expectedSize);
  const failures: string[] = [];
  if (!Number.isFinite(durationSec) || durationSec < 10 || durationSec > 600) failures.push("时长不在 10–600 秒");
  if (!Number.isFinite(sampleRate) || sampleRate < 32_000) failures.push("采样率低于 32kHz");
  if (![1, 2].includes(channels)) failures.push("声道数必须为 1 或 2");
  if (sizeBytes !== expectedSize) failures.push("文件大小与写入结果不一致");
  return { durationSec, sampleRate, channels, sizeBytes, passed: failures.length === 0, failures };
}

export async function persistCandidateAudio(candidateId: string, bytes: Uint8Array): Promise<PersistedCandidateAudio> {
  if (bytes.byteLength < 1024) throw new ApiError(502, "MiniMax 返回的候选音频过小");
  if (bytes.byteLength > MAX_CANDIDATE_BYTES) throw new ApiError(413, "候选音频超过 50MB 上限");

  const relativePath = path.join("candidates", candidateId, "master.mp3");
  const absolutePath = resolveCandidateArtifact(relativePath);
  const directory = path.dirname(absolutePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await chmod(directory, 0o700); } catch { /* best effort */ }
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  const probe = await probeAudio(absolutePath, bytes.byteLength);
  return { relativePath, absolutePath, outputHash: sha256(bytes), probe };
}
