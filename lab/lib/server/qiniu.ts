import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "./database";
import { getProviderSettings, isQiniuReady } from "./settings";

const ALLOWED_EXTENSIONS: Record<string, true> = {
  ".mp3": true, ".wav": true, ".m4a": true, ".aac": true, ".flac": true,
  ".ogg": true, ".mp4": true, ".mov": true, ".lrc": true, ".txt": true, ".zip": true,
};

function urlSafeBase64(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function qiniuSign(value: string, secretKey: string): string {
  return createHmac("sha1", secretKey).update(value).digest("base64url");
}

function normalizedDomain(domain: string): string {
  const value = domain.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new Error("七牛访问域名必须包含 http:// 或 https://");
  return value;
}

function safeObjectName(name: string): string {
  const extension = path.extname(name).slice(0, 16).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const stem = path.basename(name, path.extname(name))
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "audio";
  return `${stem}-${randomUUID()}${extension}`;
}

export async function createQiniuUploadGrant(file: { name: string; size: number; mimeType: string }, userId: string) {
  const settings = await getProviderSettings();
  if (!await isQiniuReady(settings)) throw new Error("七牛尚未在后台配置完成");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 500 * 1024 * 1024) {
    throw new Error("单个文件大小需在 1B–500MB 之间");
  }
  const mimeAllowed = /^(audio\/|video\/|text\/plain$|application\/(zip|x-zip-compressed)$)/i.test(file.mimeType);
  if (!mimeAllowed && !ALLOWED_EXTENSIONS[path.extname(file.name).toLowerCase()]) {
    throw new Error("仅支持音频、视频、LRC 文本和 ZIP 文件");
  }

  const now = new Date();
  const prefix = settings.qiniu.prefix.replace(/^\/+|\/+$/g, "") || "incoming";
  const objectKey = `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${safeObjectName(file.name)}`;
  const policy = {
    scope: `${settings.qiniu.bucket}:${objectKey}`,
    deadline: Math.floor(Date.now() / 1000) + 60 * 60,
    insertOnly: 1,
    fsizeLimit: file.size,
    detectMime: 1,
    returnBody: '{"key":$(key),"hash":$(etag),"fsize":$(fsize),"mimeType":$(mimeType)}',
  };
  const encodedPolicy = urlSafeBase64(JSON.stringify(policy));
  const signature = qiniuSign(encodedPolicy, settings.qiniu.secretKey);
  await getDb().prepare(`
    INSERT INTO upload_grants (object_key, user_id, original_name, mime_type, size_bytes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(objectKey, userId, file.name.slice(0, 240), file.mimeType, file.size, policy.deadline * 1000, Date.now());
  return {
    token: `${settings.qiniu.accessKey}:${signature}:${encodedPolicy}`,
    key: objectKey,
    region: settings.qiniu.region,
    privateBucket: settings.qiniu.privateBucket,
  };
}

export async function createQiniuObjectUrl(objectKey: string, lifetimeSeconds = 900): Promise<string> {
  const settings = await getProviderSettings();
  if (!await isQiniuReady(settings)) throw new Error("七牛尚未在后台配置完成");
  const domain = normalizedDomain(settings.qiniu.domain);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const baseUrl = `${domain}/${encodedKey}`;
  if (!settings.qiniu.privateBucket) return baseUrl;
  const deadline = Math.floor(Date.now() / 1000) + lifetimeSeconds;
  const urlToSign = `${baseUrl}?e=${deadline}`;
  const token = `${settings.qiniu.accessKey}:${qiniuSign(urlToSign, settings.qiniu.secretKey)}`;
  return `${urlToSign}&token=${encodeURIComponent(token)}`;
}
