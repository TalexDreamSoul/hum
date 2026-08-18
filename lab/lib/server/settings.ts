import "server-only";

import { decryptSecret, encryptSecret } from "./crypto";
import { getDb } from "./database";
import { isAiProtocol, type AiProtocol } from "../ai-endpoint";
import { MINIMAX_BATCH_MODELS, type MiniMaxBatchModel, type MiniMaxCurrentMusicModel } from "../minimax";

const SECRET_KEYS: Record<string, true> = {
  "qiniu.accessKey": true,
  "qiniu.secretKey": true,
  "feishu.appSecret": true,
  "ai.apiKey": true,
  "minimax.apiKey": true,
};

export interface ProviderSettings {
  publicUrl: string;
  qiniu: {
    enabled: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: "z0" | "z1" | "z2" | "na0" | "as0";
    domain: string;
    privateBucket: boolean;
    prefix: string;
  };
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
  };
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol: AiProtocol;
  };
  minimax: {
    baseUrl: string;
    apiKey: string;
    defaultModel: MiniMaxCurrentMusicModel;
    batchModel: MiniMaxBatchModel;
    requestsPerMinute: number;
  };
}

const DEFAULTS: ProviderSettings = {
  publicUrl: "",
  qiniu: {
    enabled: false,
    accessKey: "",
    secretKey: "",
    bucket: "",
    region: "z0",
    domain: "",
    privateBucket: true,
    prefix: "incoming",
  },
  feishu: { enabled: false, appId: "", appSecret: "" },
  ai: { baseUrl: "", apiKey: "", model: "", protocol: "auto" },
  minimax: {
    baseUrl: "https://api.minimaxi.com",
    apiKey: "",
    defaultModel: "music-3.0-free",
    batchModel: "music-3.0-free",
    requestsPerMinute: 3,
  },
};

export async function getProviderSettings(): Promise<ProviderSettings> {
  const rows = await getDb().prepare("SELECT key, value, encrypted FROM settings").all() as Array<{ key: string; value: string; encrypted: number }>;
  const values = new Map(rows.map((row) => [row.key, row.encrypted ? decryptSecret(row.value) : row.value]));
  const readValue = (key: string) => values.get(key) ?? "";
  const boolValue = (key: string, fallback: boolean) => values.has(key) ? readValue(key) === "1" : fallback;
  const region = readValue("qiniu.region");
  const allowedRegions: Record<string, true> = { z0: true, z1: true, z2: true, na0: true, as0: true };
  const rawAiProtocol = readValue("ai.protocol");
  const rawBatchModel = readValue("minimax.batchModel");
  const rawRequestsPerMinute = Number.parseInt(readValue("minimax.requestsPerMinute"), 10);
  const batchModel = MINIMAX_BATCH_MODELS.includes(rawBatchModel as MiniMaxBatchModel)
    ? rawBatchModel as MiniMaxBatchModel
    : DEFAULTS.minimax.batchModel;
  const requestsPerMinute = Number.isInteger(rawRequestsPerMinute) && rawRequestsPerMinute >= 1 && rawRequestsPerMinute <= 60
    ? rawRequestsPerMinute
    : DEFAULTS.minimax.requestsPerMinute;
  return {
    publicUrl: readValue("app.publicUrl"),
    qiniu: {
      enabled: boolValue("qiniu.enabled", DEFAULTS.qiniu.enabled),
      accessKey: readValue("qiniu.accessKey"),
      secretKey: readValue("qiniu.secretKey"),
      bucket: readValue("qiniu.bucket"),
      region: (allowedRegions[region] ? region : DEFAULTS.qiniu.region) as ProviderSettings["qiniu"]["region"],
      domain: readValue("qiniu.domain"),
      privateBucket: boolValue("qiniu.privateBucket", DEFAULTS.qiniu.privateBucket),
      prefix: readValue("qiniu.prefix") || DEFAULTS.qiniu.prefix,
    },
    feishu: {
      enabled: boolValue("feishu.enabled", DEFAULTS.feishu.enabled),
      appId: readValue("feishu.appId"),
      appSecret: readValue("feishu.appSecret"),
    },
    ai: {
      baseUrl: readValue("ai.baseUrl"),
      apiKey: readValue("ai.apiKey"),
      model: readValue("ai.model"),
      protocol: isAiProtocol(rawAiProtocol) ? rawAiProtocol : DEFAULTS.ai.protocol,
    },
    minimax: {
      baseUrl: readValue("minimax.baseUrl") || DEFAULTS.minimax.baseUrl,
      apiKey: readValue("minimax.apiKey"),
      defaultModel: readValue("minimax.defaultModel") === "music-3.0" ? "music-3.0" : "music-3.0-free",
      batchModel,
      requestsPerMinute,
    },
  };
}

export async function writeProviderSettings(values: Record<string, string | boolean | undefined>, userId: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  await db.transaction(async (transaction) => {
    for (const [key, input] of Object.entries(values)) {
      if (input === undefined) continue;
      const raw = typeof input === "boolean" ? (input ? "1" : "0") : input.trim();
      if (SECRET_KEYS[key] && raw === "") continue;
      if (raw === "__CLEAR_SECRET__" && SECRET_KEYS[key]) {
        await transaction.prepare("DELETE FROM settings WHERE key = ?").run(key);
        continue;
      }
      await transaction.prepare(`
        INSERT INTO settings (key, value, encrypted, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          encrypted = excluded.encrypted,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(key, SECRET_KEYS[key] ? encryptSecret(raw) : raw, SECRET_KEYS[key] ? 1 : 0, userId, now);
    }
  })();
}

export async function getMaskedProviderSettings() {
  const settings = await getProviderSettings();
  return {
    publicUrl: settings.publicUrl,
    qiniu: {
      enabled: settings.qiniu.enabled,
      accessKeySet: Boolean(settings.qiniu.accessKey),
      secretKeySet: Boolean(settings.qiniu.secretKey),
      bucket: settings.qiniu.bucket,
      region: settings.qiniu.region,
      domain: settings.qiniu.domain,
      privateBucket: settings.qiniu.privateBucket,
      prefix: settings.qiniu.prefix,
      ready: await isQiniuReady(settings),
    },
    feishu: {
      enabled: settings.feishu.enabled,
      appId: settings.feishu.appId,
      appSecretSet: Boolean(settings.feishu.appSecret),
      ready: await isFeishuReady(settings),
    },
    ai: {
      baseUrl: settings.ai.baseUrl,
      apiKeySet: Boolean(settings.ai.apiKey),
      model: settings.ai.model,
      protocol: settings.ai.protocol,
      ready: await isAiReady(settings),
    },
    minimax: {
      baseUrl: settings.minimax.baseUrl,
      apiKeySet: Boolean(settings.minimax.apiKey),
      defaultModel: settings.minimax.defaultModel,
      batchModel: settings.minimax.batchModel,
      requestsPerMinute: settings.minimax.requestsPerMinute,
      ready: await isMiniMaxReady(settings),
    },
  };
}

export async function isQiniuReady(settings?: ProviderSettings): Promise<boolean> {
  const q = (settings ?? await getProviderSettings()).qiniu;
  return q.enabled && Boolean(q.accessKey && q.secretKey && q.bucket && q.domain);
}

export async function isFeishuReady(settings?: ProviderSettings): Promise<boolean> {
  const f = (settings ?? await getProviderSettings()).feishu;
  return f.enabled && Boolean(f.appId && f.appSecret);
}

export async function isAiReady(settings?: ProviderSettings): Promise<boolean> {
  const ai = (settings ?? await getProviderSettings()).ai;
  return Boolean(ai.baseUrl && ai.apiKey && ai.model);
}

export async function isMiniMaxReady(settings?: ProviderSettings): Promise<boolean> {
  return Boolean((settings ?? await getProviderSettings()).minimax.apiKey);
}
