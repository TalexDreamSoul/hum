import "server-only";

import { createHash } from "node:crypto";
import { ApiError } from "./api";
import { getDb } from "./database";
import { MOCK_MUSIC_MODEL, MOCK_PROVIDER, MOCK_REQUESTS_PER_MINUTE, mockMarker } from "./mock-provider";
import type { MiniMaxMusicModel } from "../minimax";

export interface MiniMaxAudioSetting {
  sampleRate: 16000 | 24000 | 32000 | 44100;
  bitrate: 32000 | 64000 | 128000 | 256000;
  format: "mp3" | "wav" | "pcm";
}

export interface MiniMaxMusicRun {
  model: MiniMaxMusicModel;
  provider: typeof MOCK_PROVIDER;
  mock: true;
  ok: boolean;
  latencyMs: number;
  audioBytes?: Uint8Array;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  sizeBytes?: number;
  traceId?: string;
  error?: string;
}

/**
 * The counter is a database row, not an in-process cooldown. The UPSERT's WHERE clause is
 * evaluated while PostgreSQL holds the conflicting row lock, so concurrent workers cannot
 * exceed the three-token fixed window.
 */
export async function reserveMiniMaxRateLimit(_userId: string, models: readonly string[]): Promise<void> {
  if (!models.length || models.length > MOCK_REQUESTS_PER_MINUTE || models.some((model) => model !== MOCK_MUSIC_MODEL)) {
    throw new ApiError(400, "当前 Mock provider 只允许 music-3.0-free，且单次最多请求 3 个令牌");
  }
  const now = Date.now();
  const windowStartedAt = Math.floor(now / 60_000) * 60_000;
  const row = await getDb().prepare(`
    INSERT INTO provider_rate_limits (provider_lane, window_started_at, used_tokens, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_lane) DO UPDATE SET
      window_started_at = CASE
        WHEN provider_rate_limits.window_started_at <> excluded.window_started_at THEN excluded.window_started_at
        ELSE provider_rate_limits.window_started_at
      END,
      used_tokens = CASE
        WHEN provider_rate_limits.window_started_at <> excluded.window_started_at THEN excluded.used_tokens
        ELSE provider_rate_limits.used_tokens + excluded.used_tokens
      END,
      updated_at = excluded.updated_at
    WHERE provider_rate_limits.window_started_at <> excluded.window_started_at
       OR provider_rate_limits.used_tokens + excluded.used_tokens <= ?
    RETURNING window_started_at, used_tokens
  `).get<{ window_started_at: number; used_tokens: number }>(
    `${MOCK_PROVIDER}:${MOCK_MUSIC_MODEL}`,
    windowStartedAt,
    models.length,
    now,
    MOCK_REQUESTS_PER_MINUTE,
  );
  if (!row) {
    const waitSeconds = Math.max(1, Math.ceil((windowStartedAt + 60_000 - now) / 1000));
    throw new ApiError(429, `Mock provider 全局 3 RPM 已用尽，请在 ${waitSeconds} 秒后重试`);
  }
}

function createDeterministicMockWav(seedText: string, durationSeconds: number, signal: AbortSignal): Buffer {
  const sampleRate = 44_100;
  const channels = 1;
  const totalSamples = sampleRate * durationSeconds;
  const dataBytes = totalSamples * channels * 2;
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  const digest = createHash("sha256").update(seedText).digest();
  const bpm = 96 + (digest[0] % 17);
  const beatSeconds = 60 / bpm;
  const scale = [293.665, 329.628, 369.994, 391.995, 440, 493.883];
  const offset = digest[1] % scale.length;
  for (let index = 0; index < totalSamples; index += 1) {
    if (index % sampleRate === 0 && signal.aborted) throw new DOMException("Mock music generation cancelled", "AbortError");
    const time = index / sampleRate;
    const beat = Math.floor(time / beatSeconds);
    const beatPhase = (time / beatSeconds) - beat;
    const note = scale[(beat + offset) % scale.length];
    const phraseGain = Math.floor(time / 8) % 2 === 0 ? 0.72 : 1;
    const pulse = Math.exp(-beatPhase * 24);
    const gapPosition = time % 12;
    const gapGain = gapPosition >= 10.7 && gapPosition <= 11.4 ? 0 : 1;
    const edge = Math.min(1, time / 0.12, (durationSeconds - time) / 0.12);
    const melody = Math.sin(Math.PI * 2 * note * time) * 0.24;
    const harmony = Math.sin(Math.PI * 2 * (note / 2) * time) * 0.1;
    const rhythm = Math.sin(Math.PI * 2 * 180 * time) * pulse * 0.16;
    const sample = Math.max(-0.58, Math.min(0.58, (melody + harmony + rhythm) * phraseGain * gapGain * edge));
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return wav;
}

export async function generateMiniMaxMusic(input: {
  model: MiniMaxMusicModel;
  prompt: string;
  lyrics: string;
  lyricsOptimizer: boolean;
  instrumental: boolean;
  audioSetting?: MiniMaxAudioSetting;
  signal: AbortSignal;
  outputFormat?: "url" | "hex";
  onExchange?: (exchange: { endpoint: string; requestBody: Record<string, unknown>; status: number; responseText: string }) => void;
}): Promise<MiniMaxMusicRun> {
  if (input.model !== MOCK_MUSIC_MODEL) throw new ApiError(400, "当前 Mock provider 只允许 music-3.0-free");
  const started = Date.now();
  try {
    const durationMatch = input.prompt.match(/(?:^|\D)([4-9][0-9]|1[0-2][0-9])\s*(?:秒|seconds?)/i);
    const durationSeconds = Math.max(45, Math.min(90, Number(durationMatch?.[1] ?? 60)));
    const audioBytes = createDeterministicMockWav(
      `${input.prompt}\n${input.lyrics}\n${input.instrumental}\n${input.lyricsOptimizer}`,
      durationSeconds,
      input.signal,
    );
    const traceId = `mock-${createHash("sha256").update(audioBytes).digest("hex").slice(0, 16)}`;
    input.onExchange?.({
      endpoint: `mock://${MOCK_MUSIC_MODEL}`,
      requestBody: {
        ...mockMarker(),
        model: MOCK_MUSIC_MODEL,
        requestedOutputFormat: input.outputFormat ?? "url",
        actualFormat: "wav",
        sampleRate: 44_100,
        channels: 1,
      },
      status: 200,
      responseText: JSON.stringify({ ...mockMarker(), traceId, format: "wav", durationSeconds }),
    });
    return {
      model: MOCK_MUSIC_MODEL,
      ...mockMarker(),
      ok: true,
      latencyMs: Date.now() - started,
      audioBytes,
      durationMs: durationSeconds * 1000,
      sampleRate: 44_100,
      channels: 1,
      bitrate: 705_600,
      sizeBytes: audioBytes.byteLength,
      traceId,
    };
  } catch (error) {
    return {
      model: MOCK_MUSIC_MODEL,
      ...mockMarker(),
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Mock music generation failed",
    };
  }
}

export async function generateMiniMaxLyrics(input: {
  title: string;
  lyrics: string;
  instruction: string;
  signal: AbortSignal;
}): Promise<{ title: string; styleTags: string; lyrics: string; mock: true; provider: typeof MOCK_PROVIDER }> {
  if (input.signal.aborted) throw new DOMException("Mock lyric generation cancelled", "AbortError");
  const revision = createHash("sha256").update(`${input.title}\n${input.instruction}`).digest("hex").slice(0, 12);
  return {
    title: input.title.trim(),
    styleTags: `mock-${revision}`,
    lyrics: input.lyrics.trim(),
    ...mockMarker(),
  };
}
