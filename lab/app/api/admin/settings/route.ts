import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { getFeishuCallbackUrl } from "@/lib/server/feishu";
import { getMaskedProviderSettings, writeProviderSettings } from "@/lib/server/settings";
import { AI_PROTOCOLS } from "@/lib/ai-endpoint";
import { MINIMAX_BATCH_MODELS } from "@/lib/minimax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const optionalUrl = z.string().max(400).refine((value) => {
  if (!value.trim()) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "请输入有效的 HTTP(S) 地址");

const settingsInput = z.object({
  publicUrl: optionalUrl,
  qiniu: z.object({
    enabled: z.boolean(),
    accessKey: z.string().max(200).optional(),
    secretKey: z.string().max(300).optional(),
    clearAccessKey: z.boolean().optional(),
    clearSecretKey: z.boolean().optional(),
    bucket: z.string().max(120),
    region: z.enum(["z0", "z1", "z2", "na0", "as0"]),
    domain: optionalUrl,
    privateBucket: z.boolean(),
    prefix: z.string().max(120).refine((value) => !value.includes(".."), "目录前缀不能包含 .."),
  }),
  feishu: z.object({
    enabled: z.boolean(),
    appId: z.string().max(200),
    appSecret: z.string().max(300).optional(),
    clearAppSecret: z.boolean().optional(),
  }),
  ai: z.object({
    baseUrl: optionalUrl,
    // JWT 形态的 Key 可能有几百上千字符，别按 sk- 的长度卡
    apiKey: z.string().max(4000).optional(),
    clearApiKey: z.boolean().optional(),
    model: z.string().max(160),
    protocol: z.enum(AI_PROTOCOLS).optional(),
  }).optional(),
  minimax: z.object({
    baseUrl: optionalUrl,
    apiKey: z.string().max(4000).optional(),
    clearApiKey: z.boolean().optional(),
    defaultModel: z.enum(["music-3.0-free", "music-3.0"]),
    batchModel: z.enum(MINIMAX_BATCH_MODELS),
    requestsPerMinute: z.number().int().min(1).max(60),
  }).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(["admin"]);
    const settings = await getMaskedProviderSettings();
    const origin = settings.publicUrl.trim() || request.nextUrl.origin;
    return NextResponse.json({ ...settings, feishuCallbackUrl: getFeishuCallbackUrl(origin) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = settingsInput.parse(await request.json());
    const values: Record<string, string | boolean | undefined> = {
      "app.publicUrl": input.publicUrl,
      "qiniu.enabled": input.qiniu.enabled,
      "qiniu.accessKey": input.qiniu.clearAccessKey ? "__CLEAR_SECRET__" : input.qiniu.accessKey,
      "qiniu.secretKey": input.qiniu.clearSecretKey ? "__CLEAR_SECRET__" : input.qiniu.secretKey,
      "qiniu.bucket": input.qiniu.bucket,
      "qiniu.region": input.qiniu.region,
      "qiniu.domain": input.qiniu.domain,
      "qiniu.privateBucket": input.qiniu.privateBucket,
      "qiniu.prefix": input.qiniu.prefix,
      "feishu.enabled": input.feishu.enabled,
      "feishu.appId": input.feishu.appId,
      "feishu.appSecret": input.feishu.clearAppSecret ? "__CLEAR_SECRET__" : input.feishu.appSecret,
      "ai.baseUrl": input.ai?.baseUrl,
      "ai.apiKey": input.ai?.clearApiKey ? "__CLEAR_SECRET__" : input.ai?.apiKey,
      "ai.model": input.ai?.model,
      "ai.protocol": input.ai?.protocol,
      "minimax.baseUrl": input.minimax?.baseUrl,
      "minimax.apiKey": input.minimax?.clearApiKey ? "__CLEAR_SECRET__" : input.minimax?.apiKey,
      "minimax.defaultModel": input.minimax?.defaultModel,
      "minimax.batchModel": input.minimax?.batchModel,
      "minimax.requestsPerMinute": input.minimax?.requestsPerMinute === undefined ? undefined : String(input.minimax.requestsPerMinute),
    };
    writeProviderSettings(values, user.id);
    await recordAudit(user.id, "settings.update", "settings", "providers", {
      keys: Object.keys(values).filter((key) => values[key] !== undefined && !key.toLowerCase().includes("secret") && !key.toLowerCase().includes("key")),
    });
    const settings = await getMaskedProviderSettings();
    const origin = settings.publicUrl.trim() || request.nextUrl.origin;
    return NextResponse.json({ ...settings, feishuCallbackUrl: getFeishuCallbackUrl(origin) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
