"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, Grid, GridItem, Input, Select, Tabs, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { AI_PROTOCOL_ITEMS, AI_PROTOCOL_LABELS, type AiProtocol } from "@/lib/ai-endpoint";
import {
  MINIMAX_BATCH_MODELS,
  MINIMAX_CURRENT_MUSIC_MODELS,
  MINIMAX_MUSIC_MODEL_LABELS,
  type MiniMaxBatchModel,
  type MiniMaxCurrentMusicModel,
} from "@/lib/minimax";

type Region = "z0" | "z1" | "z2" | "na0" | "as0";

interface SettingsPayload {
  publicUrl: string;
  feishuCallbackUrl: string;
  qiniu: {
    enabled: boolean; accessKeySet: boolean; secretKeySet: boolean; bucket: string; region: Region;
    domain: string; privateBucket: boolean; prefix: string; ready: boolean;
  };
  feishu: { enabled: boolean; appId: string; appSecretSet: boolean; ready: boolean };
  ai: { baseUrl: string; apiKeySet: boolean; model: string; protocol: AiProtocol; ready: boolean };
  minimax: { baseUrl: string; apiKeySet: boolean; defaultModel: MiniMaxCurrentMusicModel; batchModel: MiniMaxBatchModel; requestsPerMinute: number; ready: boolean };
}

interface Draft {
  publicUrl: string;
  qiniu: { enabled: boolean; accessKey: string; secretKey: string; clearAccessKey: boolean; clearSecretKey: boolean; bucket: string; region: Region; domain: string; privateBucket: boolean; prefix: string };
  feishu: { enabled: boolean; appId: string; appSecret: string; clearAppSecret: boolean };
  ai: { baseUrl: string; apiKey: string; clearApiKey: boolean; model: string; protocol: AiProtocol };
  minimax: { baseUrl: string; apiKey: string; clearApiKey: boolean; defaultModel: MiniMaxCurrentMusicModel; batchModel: MiniMaxBatchModel; requestsPerMinute: number };
}

const REGION_ITEMS = [
  { value: "z0", label: "华东" },
  { value: "z1", label: "华北" },
  { value: "z2", label: "华南" },
  { value: "na0", label: "北美" },
  { value: "as0", label: "新加坡" },
] as const;

type SettingsTab = "site" | "qiniu" | "feishu" | "minimax" | "ai";

const TAB_ITEMS = [
  { value: "site", label: "站点" },
  { value: "qiniu", label: "七牛" },
  { value: "feishu", label: "飞书" },
  { value: "minimax", label: "MiniMax" },
  { value: "ai", label: "AI" },
] as const;

const MINIMAX_MODEL_ITEMS = MINIMAX_CURRENT_MUSIC_MODELS.map((value) => ({
  value,
  label: MINIMAX_MUSIC_MODEL_LABELS[value],
}));
const MINIMAX_BATCH_MODEL_ITEMS = MINIMAX_BATCH_MODELS.map((value) => ({
  value,
  label: MINIMAX_MUSIC_MODEL_LABELS[value],
}));

function toDraft(payload: SettingsPayload): Draft {
  return {
    publicUrl: payload.publicUrl,
    qiniu: {
      enabled: payload.qiniu.enabled, accessKey: "", secretKey: "", clearAccessKey: false, clearSecretKey: false,
      bucket: payload.qiniu.bucket, region: payload.qiniu.region, domain: payload.qiniu.domain,
      privateBucket: payload.qiniu.privateBucket, prefix: payload.qiniu.prefix,
    },
    feishu: { enabled: payload.feishu.enabled, appId: payload.feishu.appId, appSecret: "", clearAppSecret: false },
    ai: { baseUrl: payload.ai.baseUrl, apiKey: "", clearApiKey: false, model: payload.ai.model, protocol: payload.ai.protocol },
    minimax: {
      baseUrl: payload.minimax.baseUrl,
      apiKey: "",
      clearApiKey: false,
      defaultModel: payload.minimax.defaultModel,
      batchModel: payload.minimax.batchModel,
      requestsPerMinute: payload.minimax.requestsPerMinute,
    },
  };
}

export function SettingsForm() {
  const toast = useConsoleToast();
  const [saved, setSaved] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<SettingsTab>("site");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<SettingsTab | "">("");

  async function load() {
    const response = await fetch("/api/admin/settings", { cache: "no-store" });
    const payload = await response.json() as SettingsPayload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "读取配置失败");
    setSaved(payload);
    setDraft(toDraft(payload));
  }

  useEffect(() => { load().catch((error) => toast.error("读取配置失败", error.message)); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json() as SettingsPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "保存配置失败");
      setSaved(payload);
      setDraft(toDraft(payload));
      toast.success("配置已加密保存并立即生效");
    } catch (error) {
      toast.error("保存配置失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function runTest(target: SettingsTab) {
    setTesting(target);
    try {
      const response = await fetch("/api/admin/settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const payload = await response.json() as { ok?: boolean; title?: string; detail?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "测试失败");
      if (payload.ok) toast.success(payload.title ?? "测试通过", payload.detail);
      else toast.error(payload.title ?? "测试未通过", payload.detail);
    } catch (error) {
      toast.error("测试失败", error instanceof Error ? error.message : undefined);
    } finally {
      setTesting("");
    }
  }

  function testButton(target: SettingsTab) {
    return (
      <Button type="button" size="sm" variant="secondary" disabled={Boolean(testing) || busy} onClick={() => runTest(target)}>
        {testing === target ? "测试中…" : "测试"}
      </Button>
    );
  }

  if (!draft || !saved) return <Text variant="secondary">正在读取配置…</Text>;

  return (
    <form onSubmit={submit}>
      <Grid gap="base">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(value) => setTab(value as SettingsTab)}
          tabs={[...TAB_ITEMS]}
        />

        {tab === "site" && (
        <ConsoleSection title="站点地址" status={testButton("site")}>
          <Grid gap="sm">
            <Text variant="secondary">用于生成 OAuth 回调；留空时从当前请求的反向代理头自动判断。</Text>
            <Input label="公开地址" placeholder="https://console.example.com" value={draft.publicUrl}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, publicUrl: event.target.value })} />
          </Grid>
        </ConsoleSection>
        )}

        {tab === "qiniu" && (
        <ConsoleSection
          title="七牛对象存储"
          status={<><Badge variant={saved.qiniu.ready ? "success" : "warning"}>{saved.qiniu.ready ? "已就绪" : "待配置"}</Badge>{testButton("qiniu")}</>}
        >
          <Grid gap="sm">
            <Checkbox label="启用七牛直传" checked={draft.qiniu.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, qiniu: { ...draft.qiniu, enabled: checked } })} />
            <Grid variant="2up" gap="sm">
              <GridItem><Input label={`Access Key${saved.qiniu.accessKeySet ? "（已保存）" : ""}`} type="password" placeholder="留空保持不变" value={draft.qiniu.accessKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, qiniu: { ...draft.qiniu, accessKey: event.target.value } })} /></GridItem>
              <GridItem><Input label={`Secret Key${saved.qiniu.secretKeySet ? "（已保存）" : ""}`} type="password" placeholder="留空保持不变" value={draft.qiniu.secretKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, qiniu: { ...draft.qiniu, secretKey: event.target.value } })} /></GridItem>
              <GridItem><Input label="Bucket" value={draft.qiniu.bucket}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, qiniu: { ...draft.qiniu, bucket: event.target.value } })} /></GridItem>
              <GridItem><Input label="访问域名" placeholder="https://cdn.example.com" value={draft.qiniu.domain}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, qiniu: { ...draft.qiniu, domain: event.target.value } })} /></GridItem>
              <GridItem><Input label="入库目录前缀" value={draft.qiniu.prefix}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, qiniu: { ...draft.qiniu, prefix: event.target.value } })} /></GridItem>
              <GridItem><Select label="存储区域" value={draft.qiniu.region} items={[...REGION_ITEMS]}
                onValueChange={(value: Region | null) => value && setDraft({ ...draft, qiniu: { ...draft.qiniu, region: value } })}
                renderValue={(value: Region) => REGION_ITEMS.find((item) => item.value === value)?.label || value} /></GridItem>
            </Grid>
            <Grid variant="3up" gap="sm">
              <GridItem><Checkbox label="私有 Bucket（推荐）" checked={draft.qiniu.privateBucket}
                onCheckedChange={(checked) => setDraft({ ...draft, qiniu: { ...draft.qiniu, privateBucket: checked } })} /></GridItem>
              {saved.qiniu.accessKeySet && <GridItem><Checkbox label="清除 Access Key" checked={draft.qiniu.clearAccessKey}
                onCheckedChange={(checked) => setDraft({ ...draft, qiniu: { ...draft.qiniu, clearAccessKey: checked } })} /></GridItem>}
              {saved.qiniu.secretKeySet && <GridItem><Checkbox label="清除 Secret Key" checked={draft.qiniu.clearSecretKey}
                onCheckedChange={(checked) => setDraft({ ...draft, qiniu: { ...draft.qiniu, clearSecretKey: checked } })} /></GridItem>}
            </Grid>
          </Grid>
        </ConsoleSection>
        )}

        {tab === "feishu" && (
        <ConsoleSection
          title="飞书快捷登录"
          status={<><Badge variant={saved.feishu.ready ? "success" : "neutral"}>{saved.feishu.ready ? "已就绪" : "未启用"}</Badge>{testButton("feishu")}</>}
        >
          <Grid gap="sm">
            <Checkbox label="启用飞书 OAuth" checked={draft.feishu.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, feishu: { ...draft.feishu, enabled: checked } })} />
            <Grid variant="2up" gap="sm">
              <GridItem><Input label="App ID" value={draft.feishu.appId}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, feishu: { ...draft.feishu, appId: event.target.value } })} /></GridItem>
              <GridItem><Input label={`App Secret${saved.feishu.appSecretSet ? "（已保存）" : ""}`} type="password" placeholder="留空保持不变" value={draft.feishu.appSecret}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, feishu: { ...draft.feishu, appSecret: event.target.value } })} /></GridItem>
            </Grid>
            <Text variant="secondary">开放平台回调地址：</Text>
            <Text variant="mono-secondary">{saved.feishuCallbackUrl}</Text>
            {saved.feishu.appSecretSet && <Checkbox label="清除 App Secret" checked={draft.feishu.clearAppSecret}
              onCheckedChange={(checked) => setDraft({ ...draft, feishu: { ...draft.feishu, clearAppSecret: checked } })} />}
          </Grid>
        </ConsoleSection>
        )}

        {tab === "minimax" && (
        <ConsoleSection
          title="MiniMax 音乐"
          status={<><Badge variant={saved.minimax.ready ? "success" : "warning"}>{saved.minimax.ready ? "已就绪" : "待配置"}</Badge>{testButton("minimax")}</>}
        >
          <Grid gap="sm">
            <Text variant="secondary">API Key 加密落库，不发送到浏览器。生产实验使用后台指定的免费模型和 RPM，当前单次成本为 0。</Text>
            <Grid variant="2up" gap="sm">
              <GridItem><Input label="接口域名" description="不同账号所在的云不同：api.minimaxi.com / api.minimax.chat / api.minimax.io。填错会报 2049 invalid api key。" value={draft.minimax.baseUrl}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, minimax: { ...draft.minimax, baseUrl: event.target.value } })} /></GridItem>
              <GridItem><Input label={`MiniMax API Key${saved.minimax.apiKeySet ? "（已保存）" : ""}`} type="password" placeholder="留空保持不变" value={draft.minimax.apiKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, minimax: { ...draft.minimax, apiKey: event.target.value } })} /></GridItem>
              <GridItem><Select label="模型实验室默认模型" value={draft.minimax.defaultModel} items={MINIMAX_MODEL_ITEMS}
                onValueChange={(value: MiniMaxCurrentMusicModel | null) => value && setDraft({ ...draft, minimax: { ...draft.minimax, defaultModel: value } })}
                renderValue={(value: MiniMaxCurrentMusicModel) => MINIMAX_MUSIC_MODEL_LABELS[value]} /></GridItem>
              <GridItem><Select label="生产实验批次模型" value={draft.minimax.batchModel} items={MINIMAX_BATCH_MODEL_ITEMS}
                onValueChange={(value: MiniMaxBatchModel | null) => value && setDraft({ ...draft, minimax: { ...draft.minimax, batchModel: value } })}
                renderValue={(value: MiniMaxBatchModel) => MINIMAX_MUSIC_MODEL_LABELS[value]} /></GridItem>
              <GridItem><Input label="生产实验 RPM" type="number" min={1} max={60} value={String(draft.minimax.requestsPerMinute)}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, minimax: { ...draft.minimax, requestsPerMinute: Number(event.target.value) } })} /></GridItem>
            </Grid>
            <Text variant="secondary">当前策略：{MINIMAX_MUSIC_MODEL_LABELS[draft.minimax.batchModel]} · RPM {draft.minimax.requestsPerMinute} · 单次成本 0.0</Text>
            {saved.minimax.apiKeySet && <Checkbox label="清除 MiniMax API Key" checked={draft.minimax.clearApiKey}
              onCheckedChange={(checked) => setDraft({ ...draft, minimax: { ...draft.minimax, clearApiKey: checked } })} />}
          </Grid>
        </ConsoleSection>
        )}

        {tab === "ai" && (
        <ConsoleSection
          title="AI 端点"
          status={<><Badge variant={saved.ai.ready ? "success" : "warning"}>{saved.ai.ready ? "已就绪" : "待配置"}</Badge>{testButton("ai")}</>}
        >
          <Grid gap="sm">
            <Text variant="secondary">供服务端内容分析与模型测试复用；与七牛、飞书一样不依赖环境变量。</Text>
            <Grid variant="2up" gap="sm">
              <GridItem><Input label="Base URL" description="填到 /v1 即可，接口路径由协议决定。" value={draft.ai.baseUrl}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, ai: { ...draft.ai, baseUrl: event.target.value } })} /></GridItem>
              <GridItem><Input label={`API Key${saved.ai.apiKeySet ? "（已保存）" : ""}`} type="password" placeholder="留空保持不变" value={draft.ai.apiKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, ai: { ...draft.ai, apiKey: event.target.value } })} /></GridItem>
              <GridItem><Input label="模型" value={draft.ai.model}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, ai: { ...draft.ai, model: event.target.value } })} /></GridItem>
              <GridItem><Select label="接口协议" value={draft.ai.protocol} items={[...AI_PROTOCOL_ITEMS]}
                onValueChange={(value: AiProtocol | null) => value && setDraft({ ...draft, ai: { ...draft.ai, protocol: value } })}
                renderValue={(value: AiProtocol) => AI_PROTOCOL_LABELS[value]} /></GridItem>
            </Grid>
            <Text variant="secondary">
              自动适配先按 Chat Completions 调用，协议不匹配时改用 Responses，两种返回体都能解析；端点只支持一种协议时直接选定，可省一次探测。
            </Text>
            {saved.ai.apiKeySet && <Checkbox label="清除 API Key" checked={draft.ai.clearApiKey}
              onCheckedChange={(checked) => setDraft({ ...draft, ai: { ...draft.ai, clearApiKey: checked } })} />}
          </Grid>
        </ConsoleSection>
        )}

        <Grid gap="sm">
          <Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存并立即生效"}</Button>
          <Text variant="secondary">保存会一次性提交全部分组的改动，切换分页不会丢失已填内容；「测试」用的是已保存的配置，改完先保存再测。</Text>
        </Grid>
      </Grid>
    </form>
  );
}
