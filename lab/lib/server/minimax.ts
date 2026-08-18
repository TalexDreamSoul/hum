import "server-only";

import { ApiError } from "./api";
import { getProviderSettings, isMiniMaxReady } from "./settings";
import type { MiniMaxMusicModel } from "../minimax";

/** 音乐生成接口路径；域名由后台配置，不同账号所在的云不一样。 */
const MINIMAX_MUSIC_PATH = "/v1/music_generation";

export function minimaxMusicEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")}${MINIMAX_MUSIC_PATH}`;
}
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

const lastStartedAt = new Map<string, number>();

export async function reserveMiniMaxRateLimit(userId: string, models: readonly string[]): Promise<void> {
  const now = Date.now();
  const freeRequestCount = models.filter((model) => model.endsWith("-free")).length;
  const requestsPerMinute = (await getProviderSettings()).minimax.requestsPerMinute;
  const cooldownMs = freeRequestCount > 0 ? Math.ceil(60_000 / requestsPerMinute) * freeRequestCount : 1_000;
  const lastStarted = lastStartedAt.get(userId) ?? 0;
  if (now - lastStarted < cooldownMs) {
    const waitSeconds = Math.ceil((cooldownMs - (now - lastStarted)) / 1000);
    const prefix = freeRequestCount ? "MiniMax 免费模型限速" : "模型测试请求过快";
    throw new ApiError(429, `${prefix}，请等待 ${waitSeconds} 秒后重试`);
  }
  lastStartedAt.set(userId, now);
}

interface MiniMaxMusicResponse {
  data?: { status?: number; audio?: string };
  trace_id?: string;
  extra_info?: {
    music_duration?: number;
    music_sample_rate?: number;
    music_channel?: number;
    bitrate?: number;
    music_size?: number;
  };
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface MiniMaxMusicRun {
  model: MiniMaxMusicModel;
  ok: boolean;
  latencyMs: number;
  audioUrl?: string;
  audioBytes?: Uint8Array;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  sizeBytes?: number;
  traceId?: string;
  error?: string;
}

function safeProviderMessage(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : "上游返回未知错误";
}

function isHexAudio(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const decimal = code >= 48 && code <= 57;
    const uppercase = code >= 65 && code <= 70;
    const lowercase = code >= 97 && code <= 102;
    if (!decimal && !uppercase && !lowercase) return false;
  }
  return true;
}

export async function generateMiniMaxMusic(input: {
  model: MiniMaxMusicModel;
  prompt: string;
  lyrics: string;
  lyricsOptimizer: boolean;
  instrumental: boolean;
  signal: AbortSignal;
  outputFormat?: "url" | "hex";
  /** 记录这次真实请求：端点、请求体、状态码、返回摘要。 */
  onExchange?: (exchange: { endpoint: string; requestBody: Record<string, unknown>; status: number; responseText: string }) => void;
}): Promise<MiniMaxMusicRun> {
  const settings = await getProviderSettings();
  if (!await isMiniMaxReady(settings)) throw new ApiError(409, "请先在系统配置中保存 MiniMax API Key");

  const payload: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    stream: false,
    output_format: input.outputFormat ?? "url",
    is_instrumental: input.instrumental,
    lyrics_optimizer: input.instrumental ? false : input.lyricsOptimizer,
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
  };
  if (!input.instrumental && input.lyrics.trim()) payload.lyrics = input.lyrics;

  const started = Date.now();
  try {
    const endpoint = minimaxMusicEndpoint(settings.minimax.baseUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.minimax.apiKey}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    });
    const text = await response.text();
    // 音频是 hex/URL，回放到日志里没意义，只留结构化摘要
    input.onExchange?.({
      endpoint,
      requestBody: payload,
      status: response.status,
      responseText: text.length > 1200 ? `${text.slice(0, 1200)}…（共 ${text.length} 字符，音频正文已截断）` : text,
    });
    let body: MiniMaxMusicResponse;
    try {
      body = JSON.parse(text) as MiniMaxMusicResponse;
    } catch {
      throw new Error(`MiniMax HTTP ${response.status} 返回了非 JSON 响应`);
    }

    const statusCode = body.base_resp?.status_code;
    if (!response.ok || (statusCode !== undefined && statusCode !== 0)) {
      throw new Error(`MiniMax ${statusCode ?? response.status}: ${safeProviderMessage(body.base_resp?.status_msg)}`);
    }
    const audio = body.data?.audio;
    if (!audio) throw new Error("MiniMax 未返回音频");

    const common = {
      model: input.model,
      ok: true as const,
      latencyMs: Date.now() - started,
      durationMs: body.extra_info?.music_duration,
      sampleRate: body.extra_info?.music_sample_rate,
      channels: body.extra_info?.music_channel,
      bitrate: body.extra_info?.bitrate,
      sizeBytes: body.extra_info?.music_size,
      traceId: body.trace_id,
    };

    if ((input.outputFormat ?? "url") === "hex") {
      if (audio.length > 100 * 1024 * 1024 || audio.length % 2 !== 0 || !isHexAudio(audio)) {
        throw new Error("MiniMax 返回了无效或过大的十六进制音频");
      }
      return { ...common, audioBytes: Buffer.from(audio, "hex") };
    }

    let audioUrl: URL;
    try {
      audioUrl = new URL(audio);
    } catch {
      throw new Error("MiniMax 返回了无效音频地址");
    }
    if (audioUrl.protocol !== "https:") throw new Error("MiniMax 返回了非 HTTPS 音频地址");
    return { ...common, audioUrl: audioUrl.toString() };
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "MiniMax 生成超过 10 分钟，已停止等待"
      : error instanceof Error ? error.message : "MiniMax 生成失败";
    return { model: input.model, ok: false, latencyMs: Date.now() - started, error: message };
  }
}
