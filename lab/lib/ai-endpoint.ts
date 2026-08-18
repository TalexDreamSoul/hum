/**
 * OpenAI 兼容端点的协议适配。
 *
 * 同一份「Base URL + Key + 模型」配置可能落在两种接口上：
 * 传统的 `/chat/completions`，或新模型（gpt-5 系列等）走的 `/responses`。
 * 请求体和返回体形状都不同，这里统一收口：调用方只给 messages，只拿正文文本。
 */

export const AI_PROTOCOLS = ["auto", "chat", "responses"] as const;
export type AiProtocol = (typeof AI_PROTOCOLS)[number];
/** 实际发出请求时只会是这两种之一；auto 由调用方探测后收敛。 */
export type AiWireProtocol = Exclude<AiProtocol, "auto">;

export const AI_PROTOCOL_ITEMS = [
  { value: "auto", label: "自动适配" },
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
] as const;

export const AI_PROTOCOL_LABELS: Record<AiProtocol, string> = {
  auto: "自动适配",
  chat: "Chat Completions",
  responses: "Responses",
};

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function isAiProtocol(value: unknown): value is AiProtocol {
  return typeof value === "string" && (AI_PROTOCOLS as readonly string[]).includes(value);
}

/** 去掉末尾斜杠和写死的接口路径，只留下 base（通常到 /v1）。 */
export function normalizeAiBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses|completions)$/i, "")
    .replace(/\/+$/, "");
}

/** Base URL 里已经写死接口路径时以它为准，用户的显式意图优先于自动探测。 */
export function protocolFromBaseUrl(baseUrl: string): AiWireProtocol | null {
  const value = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (value.endsWith("/responses")) return "responses";
  if (value.endsWith("/chat/completions") || value.endsWith("/completions")) return "chat";
  return null;
}

export function aiEndpoint(baseUrl: string, protocol: AiWireProtocol): string {
  return `${normalizeAiBaseUrl(baseUrl)}${protocol === "responses" ? "/responses" : "/chat/completions"}`;
}

export function aiRequestBody(
  protocol: AiWireProtocol,
  input: { model: string; messages: AiMessage[]; temperature?: number },
): Record<string, unknown> {
  const temperature = typeof input.temperature === "number" ? { temperature: input.temperature } : {};
  if (protocol === "responses") {
    return {
      model: input.model,
      input: input.messages.map((message) => ({ role: message.role, content: message.content })),
      ...temperature,
    };
  }
  return { model: input.model, messages: input.messages, ...temperature };
}

function partsToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      if (item.type === "reasoning" || item.type === "refusal") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (Array.isArray(item.content)) return partsToText(item.content);
      return "";
    })
    .join("");
}

/**
 * 从任意上游返回体里抽出正文，兼容：
 * Responses（output_text / output[].content[]）、Chat Completions（choices[].message.content，
 * content 可能是字符串或分片数组）、以及 Anthropic 风格的顶层 content[]。
 */
export function extractAiText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;

  const outputText = partsToText(body.output_text);
  if (outputText.trim()) return outputText;

  if (Array.isArray(body.output)) {
    const text = body.output
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => item.type !== "reasoning")
      .map((item) => partsToText(item.content))
      .join("");
    if (text.trim()) return text;
  }

  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== "object") continue;
      const record = choice as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      const text = partsToText(message?.content) || partsToText(record.text);
      if (text.trim()) return text;
    }
  }

  const content = partsToText(body.content);
  if (content.trim()) return content;

  return "";
}

/** 上游错误体也没统一格式；能捞到人话就捞，捞不到返回空串。 */
export function extractAiError(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 300);
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  const error = body.error;
  if (typeof error === "string") return error.slice(0, 300);
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.slice(0, 300);
  }
  if (typeof body.message === "string") return body.message.slice(0, 300);
  return "";
}
