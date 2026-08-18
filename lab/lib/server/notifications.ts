import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { ApiError } from "./api";
import { decryptSecret, encryptSecret } from "./crypto";
import { getDb, type HumDatabase } from "./database";
import { getProviderSettings } from "./settings";

export const NOTIFICATION_EVENTS = [
  "job.waiting",
  "job.failed",
  "job.completed",
  "report.high_score",
  "report.failed",
  "report.completed",
] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];

export interface NotificationPayload {
  title: string;
  status: string;
  detail?: string;
  score?: number | null;
  grade?: string | null;
  model?: string;
  subjectId?: string;
  path?: string;
  channelId?: string;
}

interface NotificationChannelRow {
  id: string;
  name: string;
  channel_type: "feishu_app" | "feishu_webhook";
  target: string;
  secret_encrypted: string;
  config_json: string;
  enabled: number;
}

function safeText(value: unknown, limit = 300): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);
}

function cardFor(payload: NotificationPayload, publicUrl: string) {
  const lines = [
    `**状态**：${safeText(payload.status, 80)}`,
    payload.score === undefined ? "" : `**评分**：${payload.score ?? "—"}${payload.grade ? ` / ${safeText(payload.grade, 20)}` : ""}`,
    payload.model ? `**模型**：${safeText(payload.model, 100)}` : "",
    payload.detail ? `**详情**：${safeText(payload.detail, 500)}` : "",
  ].filter(Boolean);
  const path = payload.path?.startsWith("/") ? payload.path : "";
  const url = path && publicUrl ? `${publicUrl.replace(/\/+$/, "")}${path}` : "";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: payload.status.includes("失败") || payload.status.includes("不合格") ? "red" : payload.status.includes("待") ? "orange" : "blue",
      title: { tag: "plain_text", content: safeText(payload.title, 120) },
    },
    elements: [
      { tag: "markdown", content: lines.join("\n") },
      ...(url ? [{ tag: "action", actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "打开后台" }, url }] }] : []),
    ],
  };
}

async function tenantAccessToken(): Promise<string> {
  const settings = await getProviderSettings();
  if (!settings.feishu.appId || !settings.feishu.appSecret) throw new Error("飞书 App ID/Secret 尚未配置");
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: settings.feishu.appId, app_secret: settings.feishu.appSecret }),
    cache: "no-store",
  });
  const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) throw new Error(payload.msg || `飞书 tenant token 失败（HTTP ${response.status}）`);
  return payload.tenant_access_token;
}

async function deliver(channel: NotificationChannelRow, payload: NotificationPayload): Promise<{ status: number; summary: string }> {
  const settings = await getProviderSettings();
  const card = cardFor(payload, settings.publicUrl);
  if (channel.channel_type === "feishu_app") {
    const token = await tenantAccessToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ receive_id: channel.target, msg_type: "interactive", content: JSON.stringify(card) }),
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`飞书应用机器人发送失败（HTTP ${response.status}）：${text.slice(0, 160)}`);
    const result = JSON.parse(text) as { code?: number; msg?: string };
    if (result.code !== 0) throw new Error(result.msg || `飞书应用机器人返回 ${result.code}`);
    return { status: response.status, summary: result.msg || "ok" };
  }

  const secret = JSON.parse(decryptSecret(channel.secret_encrypted)) as { webhookUrl: string; signingSecret?: string };
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = secret.signingSecret
    ? { timestamp: String(timestamp), sign: createHmac("sha256", `${timestamp}\n${secret.signingSecret}`).update("").digest("base64") }
    : {};
  const response = await fetch(secret.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...signed, msg_type: "interactive", card }),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`飞书群机器人发送失败（HTTP ${response.status}）：${text.slice(0, 160)}`);
  const result = JSON.parse(text) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string };
  if ((result.code ?? result.StatusCode ?? 0) !== 0) throw new Error(result.msg || result.StatusMessage || "飞书群机器人拒绝消息");
  return { status: response.status, summary: result.msg || result.StatusMessage || "ok" };
}

export async function listNotificationChannels() {
  return getDb().prepare(`
    SELECT c.id, c.name, c.channel_type AS channelType, c.target, c.enabled,
           c.created_at AS createdAt, c.updated_at AS updatedAt,
           COALESCE(string_agg(r.event_type, ',' ORDER BY r.event_type) FILTER (WHERE r.enabled = 1), '') AS events
    FROM notification_channels c
    LEFT JOIN notification_rules r ON r.channel_id = c.id
    GROUP BY c.id ORDER BY c.updated_at DESC
  `).all();
}

export async function createNotificationChannel(input: {
  name: string;
  channelType: "feishu_app" | "feishu_webhook";
  chatId?: string;
  webhookUrl?: string;
  signingSecret?: string;
  events: NotificationEvent[];
}, userId: string) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ApiError(400, "通知渠道名称需为 1–120 个字符");
  const events = [...new Set(input.events)].filter((event): event is NotificationEvent => NOTIFICATION_EVENTS.includes(event));
  if (!events.length) throw new ApiError(400, "至少选择一个通知事件");
  const id = randomUUID();
  const now = Date.now();
  let target = "";
  let encrypted = "";
  if (input.channelType === "feishu_app") {
    target = input.chatId?.trim() ?? "";
    if (!target) throw new ApiError(400, "应用机器人需要群 chat_id");
  } else {
    const webhookUrl = input.webhookUrl?.trim() ?? "";
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new ApiError(400, "群机器人 Webhook 必须是有效 HTTPS 地址");
    }
    if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || !url.pathname.startsWith("/open-apis/bot/")) {
      throw new ApiError(400, "群机器人 Webhook 必须是 open.feishu.cn 的 HTTPS 地址");
    }
    target = "已加密 Webhook";
    encrypted = encryptSecret(JSON.stringify({ webhookUrl, signingSecret: input.signingSecret?.trim() || "" }));
  }
  const database = getDb();
  await database.transaction(async (transaction) => {
    await transaction.prepare(`
      INSERT INTO notification_channels (
        id, name, channel_type, target, secret_encrypted, config_json, enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '{}', 1, ?, ?, ?)
    `).run(id, name, input.channelType, target, encrypted, userId, now, now);
    for (const event of events) {
      await transaction.prepare(`
        INSERT INTO notification_rules (id, channel_id, event_type, filter_json, enabled, created_by, created_at)
        VALUES (?, ?, ?, '{}', 1, ?, ?)
      `).run(randomUUID(), id, event, userId, now);
    }
  })();
  return id;
}

export async function setNotificationChannelEnabled(id: string, enabled: boolean): Promise<void> {
  const result = await getDb().prepare("UPDATE notification_channels SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), id);
  if (!result.changes) throw new ApiError(404, "通知渠道不存在");
}

export async function deleteNotificationChannel(id: string): Promise<void> {
  const result = await getDb().prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
  if (!result.changes) throw new ApiError(404, "通知渠道不存在");
}

export async function enqueueNotificationEvent(
  database: HumDatabase,
  eventKey: string,
  eventType: NotificationEvent,
  payload: NotificationPayload,
): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO notification_outbox (
      id, event_key, event_type, payload_json, status, attempt_count, next_attempt_at, error, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, '', ?, NULL)
    ON CONFLICT(event_key) DO NOTHING
  `).run(randomUUID(), eventKey, eventType, JSON.stringify(payload), now, now);
}

export async function dispatchPendingNotifications(limit = 20): Promise<void> {
  const database = getDb();
  const items = await database.prepare(`
    SELECT id, event_type, payload_json, attempt_count FROM notification_outbox
    WHERE status IN ('pending','failed') AND next_attempt_at <= ? AND attempt_count < 5
    ORDER BY created_at LIMIT ?
  `).all(Date.now(), limit) as Array<{ id: string; event_type: string; payload_json: string; attempt_count: number }>;

  for (const item of items) {
    const claimed = await database.prepare(`
      UPDATE notification_outbox SET status = 'sending', attempt_count = attempt_count + 1
      WHERE id = ? AND status IN ('pending','failed')
    `).run(item.id);
    if (!claimed.changes) continue;
    const payload = JSON.parse(item.payload_json) as NotificationPayload;
    const channels = payload.channelId
      ? await database.prepare("SELECT * FROM notification_channels WHERE id = ? AND enabled = 1").all(payload.channelId) as NotificationChannelRow[]
      : await database.prepare(`
          SELECT DISTINCT c.* FROM notification_channels c
          JOIN notification_rules r ON r.channel_id = c.id
          WHERE c.enabled = 1 AND r.enabled = 1 AND r.event_type = ?
        `).all(item.event_type) as NotificationChannelRow[];
    let failed = "";
    for (const channel of channels) {
      try {
        const result = await deliver(channel, payload);
        await database.prepare(`
          INSERT INTO notification_deliveries (id, outbox_id, channel_id, status, http_status, response_summary, attempted_at)
          VALUES (?, ?, ?, 'delivered', ?, ?, ?)
          ON CONFLICT(outbox_id, channel_id) DO UPDATE SET status = 'delivered', http_status = excluded.http_status,
            response_summary = excluded.response_summary, attempted_at = excluded.attempted_at
        `).run(randomUUID(), item.id, channel.id, result.status, safeText(result.summary, 300), Date.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed = failed ? `${failed}；${message}` : message;
        await database.prepare(`
          INSERT INTO notification_deliveries (id, outbox_id, channel_id, status, http_status, response_summary, attempted_at)
          VALUES (?, ?, ?, 'failed', NULL, ?, ?)
          ON CONFLICT(outbox_id, channel_id) DO UPDATE SET status = 'failed', response_summary = excluded.response_summary,
            attempted_at = excluded.attempted_at
        `).run(randomUUID(), item.id, channel.id, safeText(message, 300), Date.now());
      }
    }
    if (!failed) {
      await database.prepare("UPDATE notification_outbox SET status = 'delivered', delivered_at = ?, error = '' WHERE id = ?")
        .run(Date.now(), item.id);
    } else {
      const attempts = item.attempt_count + 1;
      const terminal = attempts >= 5;
      const nextAttempt = Date.now() + Math.min(30 * 60_000, 2 ** attempts * 30_000);
      await database.prepare("UPDATE notification_outbox SET status = ?, next_attempt_at = ?, error = ? WHERE id = ?")
        .run(terminal ? "failed" : "pending", nextAttempt, safeText(failed, 600), item.id);
    }
  }
}

export async function testNotificationChannel(id: string): Promise<void> {
  const database = getDb();
  await enqueueNotificationEvent(database, `notification-test:${id}:${Date.now()}`, "job.completed", {
    title: "hum 飞书通知测试",
    status: "测试成功",
    detail: "群消息、卡片和后台链接配置可用。",
    path: "/console/notifications",
    channelId: id,
  });
  await dispatchPendingNotifications();
}
