import { NextResponse } from "next/server";
import { isAiProtocol, type AiMessage } from "@/lib/ai-endpoint";
import { callAiText } from "@/lib/server/ai";
import { ApiError } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * AI 中转：服务端调用用户自配端点，绕开浏览器 CORS；密钥只随请求透传，不记录不存储。
 * 协议（chat / responses）与返回体形状由 callAiText 自动适配，浏览器只拿到正文。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { baseUrl, apiKey, model, messages, temperature, protocol } = body || {};
    if (typeof baseUrl !== "string" || !/^https:\/\//.test(baseUrl)) {
      return NextResponse.json({ error: "baseUrl 必须是 https 地址" }, { status: 400 });
    }
    if (!apiKey || !model || !Array.isArray(messages)) {
      return NextResponse.json({ error: "缺少 apiKey / model / messages" }, { status: 400 });
    }
    if (JSON.stringify(messages).length > 40000) {
      return NextResponse.json({ error: "内容过长" }, { status: 413 });
    }
    const result = await callAiText({
      baseUrl,
      apiKey: String(apiKey),
      model: String(model),
      protocol: isAiProtocol(protocol) ? protocol : "auto",
      messages: (messages as AiMessage[]).map((message) => ({
        role: message.role === "system" || message.role === "assistant" ? message.role : "user",
        content: String(message.content ?? ""),
      })),
      temperature: typeof temperature === "number" ? temperature : 0.2,
      signal: req.signal,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "中转失败：" + msg }, { status: 502 });
  }
}
