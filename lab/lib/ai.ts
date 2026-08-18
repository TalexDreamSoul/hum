/**
 * 用户自配的 AI 端点（OpenAI 兼容，chat/completions 或 responses），配置只存 localStorage。
 * 请求经本站 Worker 服务端中转（无 CORS 限制）；密钥只随请求透传、不记录不存储。
 */

import { extractAiText, type AiProtocol } from "./ai-endpoint.ts";
import type { LyricsLocal } from "./lrc.ts";

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 接口协议；缺省为 auto，由服务端探测。 */
  protocol?: AiProtocol;
}

const KEY = "hum-lab-ai-v1";

export function loadAIConfig(): AIConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as AIConfig;
    return c.baseUrl && c.apiKey && c.model ? c : null;
  } catch { return null; }
}

export function saveAIConfig(c: AIConfig | null): void {
  try {
    if (!c) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* 存储被禁时静默 */ }
}

export interface LyricsAIResult {
  ageFit: number;         // 0–100，3–6 岁适配
  eduValue: number;       // 0–100
  safety: "ok" | "warn" | "bad";
  knowledgePoints: string[];
  answersAtLineEnd: "yes" | "partial" | "no";
  issues: string[];
  suggestions: string[];
  summary: string;
  model: string;
}

const SYSTEM_PROMPT = `你是儿童内容审核与教育设计专家。分析用户给出的儿歌歌词，只输出一个 JSON 对象，不要输出任何其他文字。字段：
{"ageFit":0-100 的整数（对 3-6 岁的词汇与句长适配度）,
"eduValue":0-100 的整数（知识/习惯养成价值）,
"safety":"ok"|"warn"|"bad"（暴力恐吓/广告诱导/迷信/不当价值观）,
"knowledgePoints":["歌词覆盖的知识点，最多 6 条"],
"answersAtLineEnd":"yes"|"partial"|"no"（关键答案词是否落在句尾——利于挖空接唱）,
"issues":["具体问题，最多 5 条，每条≤30字"],
"suggestions":["改进建议，最多 3 条，每条≤40字"],
"summary":"≤60字的总评"}`;

export async function analyzeLyricsAI(
  cfg: AIConfig,
  lyricsRaw: string,
  context: { durationSec?: number; bpm?: number | null; local?: LyricsLocal },
): Promise<LyricsAIResult> {
  // 经本站 Worker 中转（服务端调上游，绕开浏览器 CORS）；key 随请求转发、不落盘
  const url = "/api/ai";

  const ctxLines = [
    context.durationSec ? `歌曲时长 ${Math.round(context.durationSec)} 秒` : "",
    context.bpm ? `节奏约 ${Math.round(context.bpm)} BPM` : "",
    context.local?.medianCps ? `实测语速中位 ${context.local.medianCps} 字/秒` : "",
  ].filter(Boolean).join("；");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        protocol: cfg.protocol ?? "auto",
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${ctxLines ? ctxLines + "\n\n" : ""}歌词：\n${lyricsRaw.slice(0, 6000)}` },
        ],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("AI 请求超时（90s）");
    throw new Error("AI 请求失败：网络错误");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 160);
    try { detail = String(JSON.parse(body).error ?? detail); } catch { /* 非 JSON 错误体保持原文 */ }
    throw new Error(`AI 端点返回 ${res.status}：${detail}`);
  }
  const data = await res.json();
  // 中转已归一化为 { content }；旧形状（choices/output）再兜一层，换端点也不用改前端。
  const content: string = typeof data?.content === "string" && data.content ? data.content : extractAiText(data);
  const jsonText = content.replace(/^[\s\S]*?({[\s\S]*})[\s\S]*$/, "$1");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(jsonText); }
  catch { throw new Error("AI 返回内容无法解析为 JSON"); }

  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).slice(0, 6) : []);
  const safety = parsed.safety === "bad" ? "bad" : parsed.safety === "warn" ? "warn" : "ok";
  const aale = parsed.answersAtLineEnd === "yes" ? "yes" : parsed.answersAtLineEnd === "no" ? "no" : "partial";

  return {
    ageFit: num(parsed.ageFit),
    eduValue: num(parsed.eduValue),
    safety,
    knowledgePoints: arr(parsed.knowledgePoints),
    answersAtLineEnd: aale,
    issues: arr(parsed.issues),
    suggestions: arr(parsed.suggestions),
    summary: String(parsed.summary ?? "").slice(0, 120),
    model: cfg.model,
  };
}
