import "server-only";

import { createHmac } from "node:crypto";
import { callAiText } from "./ai";
import { ApiError } from "./api";
import { mockMarker } from "./mock-provider";
import { getProviderSettings } from "./settings";

export const PROVIDER_TEST_TARGETS = ["site", "qiniu", "feishu", "minimax", "ai"] as const;
export type ProviderTestTarget = (typeof PROVIDER_TEST_TARGETS)[number];

export interface ProviderTestResult {
  ok: boolean;
  title: string;
  detail: string;
  mock?: true;
  provider?: "mock";
}

const TIMEOUT_MS = 20_000;

function signal(outer: AbortSignal, timeoutMs = TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
}

function failureText(error: unknown): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "请求超时";
  return error instanceof Error ? error.message.slice(0, 200) : "未知错误";
}

async function testSite(outer: AbortSignal): Promise<ProviderTestResult> {
  const publicUrl = (await getProviderSettings()).publicUrl.trim();
  if (!publicUrl) {
    return { ok: true, title: "未配置公开地址", detail: "回调地址会按反向代理头自动推断；固定域名后建议填写。" };
  }
  try {
    const response = await fetch(publicUrl, { redirect: "manual", cache: "no-store", signal: signal(outer, 10_000) });
    const ok = response.status < 400;
    return {
      ok,
      title: ok ? "公开地址可访问" : `公开地址返回 ${response.status}`,
      detail: `${publicUrl} → HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, title: "公开地址无法访问", detail: `${publicUrl}：${failureText(error)}` };
  }
}

const QINIU_BUCKETS_HOST = "rs.qiniuapi.com";

/** 管理凭证 V2（IAM 子账号只认这一种）与老的 QBox 各签一次，只读列 bucket，不动任何数据。 */
function qiniuTokens(accessKey: string, secretKey: string, path: string): string[] {
  const v2 = createHmac("sha1", secretKey).update(`GET ${path}\nHost: ${QINIU_BUCKETS_HOST}\n\n`).digest("base64url");
  const legacy = createHmac("sha1", secretKey).update(`${path}\n`).digest("base64url");
  return [`Qiniu ${accessKey}:${v2}`, `QBox ${accessKey}:${legacy}`];
}

async function testQiniu(outer: AbortSignal): Promise<ProviderTestResult> {
  const settings = await getProviderSettings();
  if (!settings.qiniu.accessKey || !settings.qiniu.secretKey || !settings.qiniu.bucket) {
    throw new ApiError(409, "请先保存七牛 Access Key、Secret Key 和 Bucket");
  }
  let last = { status: 0, body: "" };
  try {
    for (const authorization of qiniuTokens(settings.qiniu.accessKey, settings.qiniu.secretKey, "/buckets")) {
      const response = await fetch(`https://${QINIU_BUCKETS_HOST}/buckets`, {
        headers: { authorization },
        cache: "no-store",
        signal: signal(outer),
      });
      const text = await response.text();
      last = { status: response.status, body: text.slice(0, 200) };
      if (response.status === 403) {
        return {
          ok: true,
          title: "七牛密钥有效，但没有列举 Bucket 的权限",
          detail: "常见于 IAM 子账号；直传用的是上传凭证，可继续在歌曲入库页实测一次上传。",
        };
      }
      if (!response.ok) continue;
      const buckets = JSON.parse(text) as unknown;
      const list = Array.isArray(buckets) ? buckets.map(String) : [];
      const hit = list.includes(settings.qiniu.bucket);
      return {
        ok: hit,
        title: hit ? "七牛密钥与 Bucket 可用" : `账号下没有 Bucket「${settings.qiniu.bucket}」`,
        detail: `账号可见 ${list.length} 个 Bucket${list.length ? `：${list.slice(0, 8).join("、")}` : ""}`,
      };
    }
    return {
      ok: false,
      title: `七牛拒绝了这组密钥（HTTP ${last.status}）`,
      detail: `${last.body || "无返回内容"}；请确认 AK/SK 完整无空格，IAM 子账号需要单独授权对象存储管理接口。`,
    };
  } catch (error) {
    return { ok: false, title: "七牛连通性测试失败", detail: failureText(error) };
  }
}

async function testFeishu(outer: AbortSignal): Promise<ProviderTestResult> {
  const settings = await getProviderSettings();
  if (!settings.feishu.appId || !settings.feishu.appSecret) {
    throw new ApiError(409, "请先保存飞书 App ID 和 App Secret");
  }
  try {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: settings.feishu.appId, app_secret: settings.feishu.appSecret }),
      cache: "no-store",
      signal: signal(outer),
    });
    const body = await response.json() as { code?: number; msg?: string; expire?: number };
    const ok = response.ok && body.code === 0;
    return {
      ok,
      title: ok ? "飞书应用凭证有效" : `飞书返回 code ${body.code ?? response.status}`,
      detail: ok
        ? `tenant_access_token 已签发，有效期 ${body.expire ?? "?"} 秒${settings.feishu.enabled ? "" : "；当前尚未勾选启用飞书 OAuth"}`
        : (body.msg ?? "App ID 或 App Secret 不正确").slice(0, 200),
    };
  } catch (error) {
    return { ok: false, title: "飞书连通性测试失败", detail: failureText(error) };
  }
}

async function testMiniMax(_outer: AbortSignal): Promise<ProviderTestResult> {
  return {
    ok: true,
    title: "Mock MiniMax provider 已就绪",
    detail: "当前环境固定使用 mock/music-3.0-free；未发起网络请求，数据库全局速率限制为 3 RPM。",
    ...mockMarker(),
  };
}

const AI_PROTOCOL_TEXT = { chat: "Chat Completions", responses: "Responses" } as const;

async function testAi(outer: AbortSignal): Promise<ProviderTestResult> {
  const settings = (await getProviderSettings()).ai;
  try {
    const result = await callAiText({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      protocol: settings.protocol,
      temperature: 0,
      timeoutMs: TIMEOUT_MS,
      signal: outer,
      messages: [{ role: "user", content: "只回复两个字：可用" }],
    });
    return {
      ok: true,
      title: "Mock AI provider 已就绪",
      detail: `provider=${result.provider} · ${result.content.trim().slice(0, 80)}`,
      ...mockMarker(),
    };
  } catch (error) {
    return { ok: false, title: "Mock AI provider 调用失败", detail: failureText(error), ...mockMarker() };
  }
}

export function testProvider(target: ProviderTestTarget, outer: AbortSignal): Promise<ProviderTestResult> {
  switch (target) {
    case "site": return testSite(outer);
    case "qiniu": return testQiniu(outer);
    case "feishu": return testFeishu(outer);
    case "minimax": return testMiniMax(outer);
    case "ai": return testAi(outer);
  }
}
