import "server-only";

import {
  aiEndpoint,
  aiRequestBody,
  extractAiError,
  extractAiText,
  protocolFromBaseUrl,
  type AiMessage,
  type AiProtocol,
  type AiWireProtocol,
} from "../ai-endpoint";
import { ApiError } from "./api";

export interface AiExchange {
  endpoint: string;
  protocol: AiWireProtocol;
  requestBody: Record<string, unknown>;
  status: number;
  responseText: string;
}

export interface AiTextRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 默认 auto：先按 chat 打，识别到协议不匹配再换 responses。 */
  protocol?: AiProtocol;
  messages: AiMessage[];
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 每次真实请求都会回调一次：端点、请求体、状态码、原始返回，供任务留痕。 */
  onExchange?: (exchange: AiExchange) => void;
}

export interface AiTextResult {
  content: string;
  protocol: AiWireProtocol;
  model: string;
}

type AttemptFailure = { ok: false; status: number; message: string; mismatch: boolean };
type Attempt = { ok: true; content: string } | AttemptFailure;

/** 这些状态码通常意味着「该端点不吃这种协议」，换一种值得试；401/403/429/5xx 换了也一样。 */
const MISMATCH_STATUS = new Set([400, 404, 405, 415, 422, 501]);

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function attempt(
  protocol: AiWireProtocol,
  request: AiTextRequest,
  temperature: number | undefined,
): Promise<Attempt> {
  const endpoint = aiEndpoint(request.baseUrl, protocol);
  const requestBody = aiRequestBody(protocol, { model: request.model, messages: request.messages, temperature });
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: withTimeout(request.signal, request.timeoutMs ?? 85_000),
    });
  } catch (error) {
    const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    request.onExchange?.({ endpoint, protocol, requestBody, status: 0, responseText: String(error) });
    return {
      ok: false,
      status: 0,
      message: timeout ? "请求超时或被中断" : error instanceof Error ? error.message : "网络错误",
      mismatch: false,
    };
  }

  const raw = await response.text();
  request.onExchange?.({ endpoint, protocol, requestBody, status: response.status, responseText: raw });
  let payload: unknown = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    /* 非 JSON 返回体保持原文，交给下面的抽取逻辑判空 */
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractAiError(payload),
      mismatch: MISMATCH_STATUS.has(response.status),
    };
  }

  const content = extractAiText(payload);
  // 200 却抽不出正文：多半是返回体形状不属于已知协议，换一种协议再试。
  if (!content.trim()) return { ok: false, status: 200, message: "", mismatch: true };
  return { ok: true, content };
}

async function attemptWithTemperatureFallback(protocol: AiWireProtocol, request: AiTextRequest): Promise<Attempt> {
  const result = await attempt(protocol, request, request.temperature);
  if (
    request.temperature !== undefined
    && !result.ok
    && result.status === 400
    && /temperature/i.test(result.message)
  ) {
    // gpt-5 系列这类推理模型只接受默认采样温度，去掉参数重试一次。
    return attempt(protocol, request, undefined);
  }
  return result;
}

/**
 * 用后台（或用户自配）的 OpenAI 兼容端点取一段纯文本。
 * 协议、请求体和返回体形状的差异都在这里吸收，调用方只关心 content。
 */
export async function callAiText(request: AiTextRequest): Promise<AiTextResult> {
  const baseUrl = request.baseUrl.trim();
  if (!baseUrl || !request.apiKey.trim() || !request.model.trim()) {
    throw new ApiError(409, "请先在系统配置中填写完整的 AI Base URL、API Key 和模型");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ApiError(409, "AI Base URL 配置无效");
  }
  if (parsed.protocol !== "https:") throw new ApiError(409, "AI Base URL 必须使用 HTTPS");

  const pinned = protocolFromBaseUrl(baseUrl)
    ?? (request.protocol && request.protocol !== "auto" ? request.protocol : null);
  const order: AiWireProtocol[] = pinned ? [pinned] : ["chat", "responses"];

  let failure: AttemptFailure | null = null;
  for (const protocol of order) {
    const result = await attemptWithTemperatureFallback(protocol, request);
    if (result.ok) return { content: result.content, protocol, model: request.model };
    failure = result;
    if (!result.mismatch) break;
  }

  if (!failure) throw new ApiError(502, "AI 调用失败");
  if (failure.status === 0) throw new ApiError(502, `AI 调用失败：${failure.message || "上游连接失败或请求被中断"}`);
  if (failure.status === 200) throw new ApiError(502, "AI 返回内容为空或格式无法识别");
  throw new ApiError(502, `AI 调用失败（上游 ${failure.status}${failure.message ? `：${failure.message}` : ""}）`);
}
