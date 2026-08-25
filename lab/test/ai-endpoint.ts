/**
 * AI 端点协议适配冒烟：不同上游返回体 → 同一段正文。
 * 跑法：node test/ai-endpoint.ts   （Node 24 原生剥离 TS 类型）
 */

import {
  aiEndpoint,
  aiRequestBody,
  extractAiError,
  extractAiText,
  normalizeAiBaseUrl,
  protocolFromBaseUrl,
} from "../lib/ai-endpoint.ts";

let failed = 0;
function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

const TEXT = '{"ok":1}';

// ── 返回体形状 ──
const shapes: Array<[string, unknown]> = [
  ["chat·字符串 content", { choices: [{ message: { role: "assistant", content: TEXT } }] }],
  ["chat·分片数组 content", { choices: [{ message: { content: [{ type: "text", text: TEXT }] } }] }],
  ["responses·output_text", { output_text: TEXT, output: [] }],
  ["responses·output[] 跳过 reasoning", {
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: TEXT }] },
    ],
  }],
  ["anthropic·顶层 content[]", { content: [{ type: "text", text: TEXT }] }],
];
for (const [name, payload] of shapes) {
  const got = extractAiText(payload);
  check(name, got === TEXT, JSON.stringify(got));
}

const empty = extractAiText({ output: [{ type: "reasoning", summary: [] }], choices: [] });
check("空正文返回空串", empty === "", JSON.stringify(empty));

check(
  "上游错误取 error.message",
  extractAiError({ error: { message: "model not found" } }) === "model not found",
  extractAiError({ error: { message: "model not found" } }),
);

// ── 端点解析 ──
const bases = [
  ["https://relay.example.com/v1/", "https://relay.example.com/v1"],
  ["https://relay.example.com/v1/chat/completions", "https://relay.example.com/v1"],
  ["https://relay.example.com/v1/responses", "https://relay.example.com/v1"],
];
for (const [input, expected] of bases) {
  const got = normalizeAiBaseUrl(input);
  check(`base 归一化 ${input}`, got === expected, got);
}

check(
  "写死路径时协议以路径为准",
  protocolFromBaseUrl("https://x.dev/v1/responses") === "responses"
    && protocolFromBaseUrl("https://x.dev/v1/chat/completions") === "chat"
    && protocolFromBaseUrl("https://x.dev/v1") === null,
  "responses / chat / null",
);

check(
  "端点拼接",
  aiEndpoint("https://x.dev/v1/", "responses") === "https://x.dev/v1/responses"
    && aiEndpoint("https://x.dev/v1/responses", "chat") === "https://x.dev/v1/chat/completions",
  "responses / chat",
);

// ── 请求体形状 ──
const messages = [{ role: "user" as const, content: "hi" }];
const chatBody = aiRequestBody("chat", { model: "m", messages, temperature: 0.2 });
const responsesBody = aiRequestBody("responses", { model: "m", messages });
check(
  "chat 用 messages 且带温度",
  Array.isArray(chatBody.messages) && chatBody.temperature === 0.2,
  JSON.stringify(chatBody),
);
check(
  "responses 用 input 且可省温度",
  Array.isArray(responsesBody.input) && !("temperature" in responsesBody),
  JSON.stringify(responsesBody),
);

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
