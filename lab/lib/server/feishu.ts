import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getCurrentUser, type SessionUser } from "./auth";
import { cleanExpiredSecurityRows, getDb } from "./database";
import { getProviderSettings, isFeishuReady } from "./settings";

interface FeishuTokenResponse {
  code?: number;
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface FeishuUserResponse {
  code: number;
  msg?: string;
  data?: {
    name?: string;
    avatar_url?: string;
    open_id?: string;
    union_id?: string;
    tenant_key?: string;
  };
}

export interface LinkedIdentity {
  provider: "feishu";
  displayName: string;
  avatarUrl: string;
  linkedAt: number;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export async function resolvePublicOrigin(request: NextRequest): Promise<string> {
  const configured = (await getProviderSettings()).publicUrl.trim().replace(/\/+$/, "");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("公开地址必须是 HTTP(S) URL");
    return url.origin;
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) return `${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

function safeReturnTo(value: string | null): string {
  return value?.startsWith("/console") && !value.startsWith("//") ? value : "/console";
}

export function getFeishuCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/auth/feishu/callback`;
}

export async function beginFeishuOAuth(
  request: NextRequest,
  mode: "login" | "link",
  returnToInput: string | null,
): Promise<string> {
  const settings = await getProviderSettings();
  if (!await isFeishuReady(settings)) throw new Error("飞书登录尚未在后台配置完成");
  const currentUser = await getCurrentUser();
  if (mode === "link" && !currentUser) throw new Error("请先使用账号密码登录");
  if (mode === "login" && currentUser) throw new Error("当前已经登录");

  await cleanExpiredSecurityRows();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const redirectUri = getFeishuCallbackUrl(await resolvePublicOrigin(request));
  await getDb().prepare(`
    INSERT INTO oauth_states (state_hash, mode, user_id, return_to, redirect_uri, code_verifier, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sha256Base64Url(state),
  mode,
  currentUser?.id ?? null,
  safeReturnTo(returnToInput),
  redirectUri,
  verifier,
  Date.now() + 10 * 60 * 1000,
  Date.now(),);

  const authorize = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorize.searchParams.set("client_id", settings.feishu.appId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", sha256Base64Url(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  return authorize.toString();
}

export async function completeFeishuOAuth(
  request: NextRequest,
  state: string,
  code: string,
): Promise<{ mode: "login" | "link"; userId: string; returnTo: string; identity: LinkedIdentity }> {
  await cleanExpiredSecurityRows();
  const db = getDb();
  const stateRow = await db.prepare(`
    SELECT mode, user_id, return_to, redirect_uri, code_verifier, expires_at
    FROM oauth_states WHERE state_hash = ?
  `).get(sha256Base64Url(state)) as
    | { mode: "login" | "link"; user_id: string | null; return_to: string; redirect_uri: string; code_verifier: string; expires_at: number }
    | undefined;
  if (!stateRow || stateRow.expires_at <= Date.now()) throw new Error("授权状态已失效，请重新发起");
  await db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(sha256Base64Url(state));

  const settings = await getProviderSettings();
  if (!await isFeishuReady(settings)) throw new Error("飞书登录配置已停用");
  if (stateRow.mode === "link") {
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.id !== stateRow.user_id) throw new Error("登录会话已变化，请重新关联");
  }

  const tokenResponse = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: settings.feishu.appId,
      client_secret: settings.feishu.appSecret,
      code,
      redirect_uri: stateRow.redirect_uri,
      code_verifier: stateRow.code_verifier,
    }),
    cache: "no-store",
  });
  const token = await tokenResponse.json() as FeishuTokenResponse;
  if (!tokenResponse.ok || token.code || !token.access_token) {
    throw new Error(token.error_description || token.error || "飞书令牌交换失败");
  }

  const infoResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    headers: { authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
  });
  const info = await infoResponse.json() as FeishuUserResponse;
  if (!infoResponse.ok || info.code !== 0 || !info.data?.open_id) throw new Error(info.msg || "无法读取飞书用户信息");

  const subject = info.data.union_id || `${info.data.tenant_key || "tenant"}:${info.data.open_id}`;
  const existing = await db.prepare(`
    SELECT user_id FROM auth_identities WHERE provider = 'feishu' AND subject = ?
  `).get(subject) as { user_id: string } | undefined;
  let userId: string;
  if (stateRow.mode === "link") {
    userId = stateRow.user_id!;
    if (existing && existing.user_id !== userId) throw new Error("该飞书账号已经关联其他用户");
  } else {
    if (!existing) throw new Error("该飞书账号尚未关联，请先使用账号密码登录后在个人资料中关联");
    userId = existing.user_id;
  }

  const identity: LinkedIdentity = {
    provider: "feishu" as const,
    displayName: info.data.name || "飞书用户",
    avatarUrl: info.data.avatar_url || "",
    linkedAt: Date.now(),
  };
  await db.prepare(`
    INSERT INTO auth_identities (id, user_id, provider, subject, display_name, avatar_url, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'feishu', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      subject = excluded.subject,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(randomUUID(),
  userId,
  subject,
  identity.displayName,
  identity.avatarUrl,
  JSON.stringify({ openId: info.data.open_id, unionId: info.data.union_id, tenantKey: info.data.tenant_key }),
  identity.linkedAt,
  identity.linkedAt,);
  return { mode: stateRow.mode, userId, returnTo: stateRow.return_to, identity };
}

export async function getLinkedFeishuIdentity(userId: string): Promise<LinkedIdentity | null> {
  const row = await getDb().prepare(`
    SELECT display_name, avatar_url, created_at FROM auth_identities
    WHERE user_id = ? AND provider = 'feishu'
  `).get(userId) as { display_name: string; avatar_url: string; created_at: number } | undefined;
  return row ? { provider: "feishu", displayName: row.display_name, avatarUrl: row.avatar_url, linkedAt: row.created_at } : null;
}

export async function unlinkFeishuIdentity(user: SessionUser): Promise<void> {
  const result = await getDb().prepare("DELETE FROM auth_identities WHERE user_id = ? AND provider = 'feishu'").run(user.id);
  if (!result.changes) throw new Error("当前账号尚未关联飞书");
}
