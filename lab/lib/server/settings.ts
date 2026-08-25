import "server-only";

import { decryptSecret, encryptSecret } from "./crypto";
import { getDb } from "./database";
import { isAiProtocol, type AiProtocol } from "../ai-endpoint";
import type { MiniMaxCurrentMusicModel } from "../minimax";
import { MOCK_ENABLED, MOCK_MUSIC_MODEL, MOCK_PROVIDER, MOCK_REQUESTS_PER_MINUTE, mockMarker } from "./mock-provider";

const SECRET_KEYS: Record<string, true> = {
  "qiniu.accessKey": true,
  "qiniu.secretKey": true,
  "feishu.appSecret": true,
  "ai.apiKey": true,
  "minimax.apiKey": true,
};

export interface ProviderSettings {
  mockEnabled: true;
  mockProvider: typeof MOCK_PROVIDER;
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
    enabledModels: MiniMaxCurrentMusicModel[];
    requestsPerMinute: number;
  };
}

const DEFAULTS: ProviderSettings = {
  mockEnabled: MOCK_ENABLED,
  mockProvider: MOCK_PROVIDER,
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
    baseUrl: "mock://music",
    apiKey: "",
    defaultModel: MOCK_MUSIC_MODEL,
    enabledModels: [MOCK_MUSIC_MODEL],
    requestsPerMinute: MOCK_REQUESTS_PER_MINUTE,
  },
};;

export async function getProviderSettings(): Promise<ProviderSettings> {
  const rows = await getDb().prepare("SELECT key, value, encrypted FROM settings").all() as Array<{ key: string; value: string; encrypted: number }> ;
  const values = new Map(rows.map((row) => [row.key, row.encrypted ? decryptSecret(row.value) : row.value]));
  const readValue = (key: string) => values.get(key) ?? "";
  const boolValue = (key: string, fallback: boolean) => values.has(key) ? readValue(key) === "1" : fallback;
  const region = readValue("qiniu.region");
  const allowedRegions: Record<string, true> = { z0: true, z1: true, z2: true, na0: true, as0: true };
  const rawAiProtocol = readValue("ai.protocol");

  return {
    mockEnabled: MOCK_ENABLED,
    mockProvider: MOCK_PROVIDER,
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
      baseUrl: DEFAULTS.minimax.baseUrl,
      apiKey: "",
      defaultModel: MOCK_MUSIC_MODEL,
      enabledModels: [MOCK_MUSIC_MODEL],
      requestsPerMinute: MOCK_REQUESTS_PER_MINUTE,
    },
  };
}

export async function writeProviderSettings(values: Record<string, string | boolean | undefined>, userId: string): Promise<void> {
  const lockedMockKeys: Record<string, true> = {
    "minimax.baseUrl": true,
    "minimax.apiKey": true,
    "minimax.defaultModel": true,
    "minimax.enabledModels": true,
    "minimax.requestsPerMinute": true,
  };
  const database = getDb();
  const now = Date.now();
  await database.transaction(async (transaction) => {
    for (const [key, input] of Object.entries(values)) {
      if (input === undefined || lockedMockKeys[key]) continue;
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
    mockEnabled: settings.mockEnabled,
    provider: settings.mockProvider,
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
      ...mockMarker(),
    },
    minimax: {
      baseUrl: settings.minimax.baseUrl,
      apiKeySet: false,
      defaultModel: settings.minimax.defaultModel,
      enabledModels: settings.minimax.enabledModels,
      requestsPerMinute: settings.minimax.requestsPerMinute,
      ready: await isMiniMaxReady(settings),
      ...mockMarker(),
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

export async function isAiReady(_settings?: ProviderSettings): Promise<boolean> {
  return MOCK_ENABLED;
}

export async function isMiniMaxReady(_settings?: ProviderSettings): Promise<boolean> {
  return MOCK_ENABLED;
}
