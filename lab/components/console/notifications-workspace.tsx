"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Checkbox, Grid, GridItem, Input, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

interface ChannelRow {
  id: string;
  name: string;
  channelType: "feishu_app" | "feishu_webhook";
  target: string;
  enabled: number;
  events: string;
  createdAt: number;
  updatedAt: number;
}

const CHANNEL_ITEMS = [
  { value: "feishu_app", label: "飞书应用机器人（chat_id）" },
  { value: "feishu_webhook", label: "飞书群机器人 Webhook" },
] as const;

const EVENT_LABEL: Record<string, string> = {
  "job.waiting": "待人工确认",
  "job.failed": "任务失败",
  "job.completed": "任务完成",
  "report.high_score": "高分报告",
  "report.failed": "不合格报告",
  "report.completed": "普通报告完成",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export function NotificationsWorkspace() {
  const toast = useConsoleToast();
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [name, setName] = useState("生产进度群");
  const [channelType, setChannelType] = useState<(typeof CHANNEL_ITEMS)[number]["value"]>("feishu_app");
  const [chatId, setChatId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["job.waiting", "job.failed", "job.completed", "report.high_score", "report.failed"]);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const payload = await requestJson<{ channels: ChannelRow[]; events: string[] }>("/api/admin/notifications");
    setChannels(payload.channels);
    setEvents(payload.events);
  }, []);

  useEffect(() => { load().catch((error) => toast.error("读取通知配置失败", error.message)); }, [load]);

  async function createChannel() {
    setBusy("create");
    try {
      await requestJson("/api/admin/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, channelType, chatId, webhookUrl, signingSecret, events: selectedEvents }),
      });
      setWebhookUrl("");
      setSigningSecret("");
      await load();
      toast.success("飞书通知渠道已创建");
    } catch (error) {
      toast.error("创建通知渠道失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function patch(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/notifications/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await load();
    } catch (error) {
      toast.error("更新通知渠道失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/notifications/${id}`, { method: "DELETE" });
      await load();
    } catch (error) {
      toast.error("删除通知渠道失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function test(id: string) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/notifications/${id}/test`, { method: "POST" });
      toast.success("测试消息已发送");
    } catch (error) {
      toast.error("测试消息发送失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  return (
    <Grid gap="base">
      <ConsoleSection title="新建飞书通知渠道">
        <Grid gap="sm">
          <Grid variant="2up" gap="sm">
            <GridItem><Input label="渠道名称" value={name} onValueChange={setName} /></GridItem>
            <GridItem><Select label="发送方式" value={channelType} items={[...CHANNEL_ITEMS]} onValueChange={(value) => value && setChannelType(value)} /></GridItem>
          </Grid>
          {channelType === "feishu_app" ? (
            <Input label="群 chat_id" description="应用机器人必须已加入该群，并在飞书开放平台开通消息权限。" value={chatId} onValueChange={setChatId} />
          ) : (
            <Grid variant="2up" gap="sm">
              <GridItem><Input label="群机器人 Webhook" value={webhookUrl} onValueChange={setWebhookUrl} /></GridItem>
              <GridItem><Input label="签名密钥（可选）" type="password" value={signingSecret} onValueChange={setSigningSecret} /></GridItem>
            </Grid>
          )}
          <Text bold>推送事件</Text>
          <Grid variant="2up" gap="sm">
            {events.map((event) => (
              <GridItem key={event}>
                <Checkbox
                  label={EVENT_LABEL[event] ?? event}
                  checked={selectedEvents.includes(event)}
                  onCheckedChange={(checked) => setSelectedEvents((current) => checked
                    ? [...new Set([...current, event])]
                    : current.filter((item) => item !== event))}
                />
              </GridItem>
            ))}
          </Grid>
          <Text variant="secondary">默认只推送待确认、失败、完成、高分和不合格；普通步骤不逐条刷群。投递进入 Outbox，失败自动退避重试并保留记录。</Text>
          <Button disabled={busy === "create" || !name.trim() || !selectedEvents.length} onClick={createChannel}>{busy === "create" ? "正在创建…" : "创建渠道"}</Button>
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="通知渠道" status={<Badge variant="neutral">{channels.length} 个</Badge>}>
        <Table>
          <thead><tr><th>渠道</th><th>类型</th><th>目标</th><th>事件</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td><Text bold>{channel.name}</Text><Text variant="mono-secondary">{channel.id.slice(0, 8)}</Text></td>
                <td>{CHANNEL_ITEMS.find((item) => item.value === channel.channelType)?.label ?? channel.channelType}</td>
                <td>{channel.target}</td>
                <td>{channel.events.split(",").filter(Boolean).map((event) => EVENT_LABEL[event] ?? event).join("、") || "—"}</td>
                <td><Badge variant={channel.enabled ? "success" : "neutral"}>{channel.enabled ? "启用" : "停用"}</Badge></td>
                <td>
                  <Grid gap="sm">
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => test(channel.id)}>测试</Button>
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => patch(channel.id, !channel.enabled)}>{channel.enabled ? "停用" : "启用"}</Button>
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => remove(channel.id)}>删除</Button>
                  </Grid>
                </td>
              </tr>
            ))}
            {!channels.length && <tr><td colSpan={6}><Text variant="secondary">尚未配置通知渠道。任务和报告仍正常执行，只是不发送群消息。</Text></td></tr>}
          </tbody>
        </Table>
      </ConsoleSection>
    </Grid>
  );
}
