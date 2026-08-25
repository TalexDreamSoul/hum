"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Grid, GridItem, Input, Select, Table, Tabs, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

const DEFAULT_STAGES = [
  { key: "knowledge_expand", label: "知识扩写" },
  { key: "song_generate", label: "免费候选" },
  { key: "media_analyze", label: "媒体评分" },
  { key: "human_review", label: "人工复审" },
  { key: "notify", label: "进度通知" },
];

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  retry_wait: "等待重试",
  awaiting_review: "等待人工复审",
  succeeded: "已完成",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消",
  active: "启用",
  retired: "已退役",
};

type Role = "admin" | "approver";
type Tab = "templates" | "plans" | "schedules";
type Editor = { kind: "template" | "template-edit" | "revision" | "plan" | "schedule"; itemId?: string } | null;

interface TemplateRow {
  id: string;
  templateKey: string;
  name: string;
  description: string;
  status: "draft" | "active" | "retired";
  currentRevision: number;
  currentRevisionId: string;
  stages: Array<{ key: string; label: string }>;
  updatedAt: number;
}

interface PlanRow {
  id: string;
  templateRevisionId: string;
  templateKey: string;
  templateName: string;
  revision: number;
  name: string;
  status: string;
  attempt: number;
  error: string;
  updatedAt: number;
  mockEnabled: boolean;
}

interface ScheduleRow {
  id: string;
  templateRevisionId: string;
  templateName: string;
  revision: number;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  planName: string;
  nextRunAt: number;
  lastRunAt: number | null;
}

interface PageResult<T> { items: T[]; page: number; pageSize: number; total: number }

function formatTime(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export function PipelinesWorkspace({ role }: { role: Role }) {
  const toast = useConsoleToast();
  const [tab, setTab] = useState<Tab>("templates");
  const [templates, setTemplates] = useState<PageResult<TemplateRow>>({ items: [], page: 1, pageSize: 10, total: 0 });
  const [plans, setPlans] = useState<PageResult<PlanRow>>({ items: [], page: 1, pageSize: 10, total: 0 });
  const [schedules, setSchedules] = useState<PageResult<ScheduleRow>>({ items: [], page: 1, pageSize: 10, total: 0 });
  const [editor, setEditor] = useState<Editor>(null);
  const [detail, setDetail] = useState<{
    id: string; name: string; status: string;
    stages: Array<{ stageKey: string; status: string; checkpoint: Record<string, unknown>; error: string }>;
    events: Array<{ id: number; eventType: string; createdAt: number }>;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [templateKey, setTemplateKey] = useState("knowledge-to-song-mock");
  const [templateName, setTemplateName] = useState("知识到歌曲 Mock 流水线");
  const [templateDescription, setTemplateDescription] = useState("Mock 知识扩写、WAV 候选、媒体检查与人工复审。");
  const [revisionId, setRevisionId] = useState("");
  const [planName, setPlanName] = useState("新的知识歌曲计划");
  const [planTheme, setPlanTheme] = useState("交通安全");
  const [scheduleName, setScheduleName] = useState("每日 10 个音频");
  const [schedulePlanName, setSchedulePlanName] = useState("每日自动音频");
  const [intervalMinutes, setIntervalMinutes] = useState("1440");
  const [batchSize, setBatchSize] = useState("10");

  const loadTemplates = useCallback(async (page: number, pageSize: number) => {
    const payload = await requestJson<PageResult<TemplateRow>>(`/api/admin/pipelines/templates?page=${page}&pageSize=${pageSize}`);
    setTemplates(payload);
  }, []);
  const loadPlans = useCallback(async (page: number, pageSize: number) => {
    const payload = await requestJson<PageResult<PlanRow>>(`/api/admin/pipelines/plans?page=${page}&pageSize=${pageSize}`);
    setPlans(payload);
  }, []);
  const loadSchedules = useCallback(async (page: number, pageSize: number) => {
    const payload = await requestJson<PageResult<ScheduleRow>>(`/api/admin/pipelines/schedules?page=${page}&pageSize=${pageSize}`);
    setSchedules(payload);
  }, []);
  const reload = useCallback(async () => {
    await Promise.all([
      loadTemplates(templates.page, templates.pageSize),
      loadPlans(plans.page, plans.pageSize),
      loadSchedules(schedules.page, schedules.pageSize),
    ]);
  }, [
    loadPlans,
    loadSchedules,
    loadTemplates,
    plans.page,
    plans.pageSize,
    schedules.page,
    schedules.pageSize,
    templates.page,
    templates.pageSize,
  ]);

  useEffect(() => {
    loadTemplates(templates.page, templates.pageSize)
      .catch((error) => toast.error("读取流水线失败", error instanceof Error ? error.message : undefined));
  }, [loadTemplates, templates.page, templates.pageSize, toast]);
  useEffect(() => {
    loadPlans(plans.page, plans.pageSize)
      .catch((error) => toast.error("读取流水线失败", error instanceof Error ? error.message : undefined));
  }, [loadPlans, plans.page, plans.pageSize, toast]);
  useEffect(() => {
    loadSchedules(schedules.page, schedules.pageSize)
      .catch((error) => toast.error("读取流水线失败", error instanceof Error ? error.message : undefined));
  }, [loadSchedules, schedules.page, schedules.pageSize, toast]);

  const revisions = useMemo(() => templates.items
    .filter((item) => item.status === "active")
    .map((item) => ({ value: item.currentRevisionId, label: `${item.name} · v${item.currentRevision}` })), [templates.items]);

  async function createOrUpdateTemplate() {
    setBusy("template");
    try {
      if (editor?.kind === "template-edit" && editor.itemId) {
        await requestJson(`/api/admin/pipelines/templates/${editor.itemId}`, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: templateName, description: templateDescription }),
        });
      } else {
        await requestJson("/api/admin/pipelines/templates", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateKey, name: templateName, description: templateDescription, stages: DEFAULT_STAGES }),
        });
      }
      setEditor(null);
      await reload();
      toast.success(editor?.kind === "template-edit" ? "模板已更新" : "模板已创建");
    } catch (error) {
      toast.error("保存模板失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function createRevision() {
    if (!editor?.itemId) return;
    setBusy("revision");
    try {
      await requestJson(`/api/admin/pipelines/templates/${editor.itemId}/revisions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stages: DEFAULT_STAGES }),
      });
      setEditor(null);
      await reload();
      toast.success("新修订已创建");
    } catch (error) {
      toast.error("创建修订失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function createPlan() {
    if (!revisionId) return;
    setBusy("plan");
    try {
      await requestJson("/api/admin/pipelines/plans", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateRevisionId: revisionId, name: planName, subjectType: "topic", input: { theme: planTheme } }),
      });
      setEditor(null);
      await loadPlans(1, plans.pageSize);
      toast.success("计划已创建并在 after() 中执行", "所有阶段均标记为 Mock provider。" );
    } catch (error) {
      toast.error("创建计划失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function createSchedule() {
    if (!revisionId) return;
    setBusy("schedule");
    try {
      await requestJson("/api/admin/pipelines/schedules", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateRevisionId: revisionId,
          name: scheduleName,
          intervalMinutes: Number(intervalMinutes),
          batchSize: Number(batchSize),
          planName: schedulePlanName,
          subjectType: "topic",
          input: { theme: planTheme },
        }),
      });
      setEditor(null);
      await loadSchedules(1, schedules.pageSize);
      toast.success("计划任务已创建");
    } catch (error) {
      toast.error("创建计划任务失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function updateTemplateStatus(item: TemplateRow, status: "retired" | "active") {
    setBusy(item.id);
    try {
      await requestJson(`/api/admin/pipelines/templates/${item.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
      await loadTemplates(templates.page, templates.pageSize);
    } catch (error) {
      toast.error("更新模板失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function removeTemplate(item: TemplateRow) {
    setBusy(item.id);
    try {
      await requestJson(`/api/admin/pipelines/templates/${item.id}`, { method: "DELETE" });
      await loadTemplates(templates.page, templates.pageSize);
      toast.success("草稿模板已删除");
    } catch (error) {
      toast.error("删除模板失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function controlPlan(id: string, action: string) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/pipelines/plans/${id}/control`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
      });
      await loadPlans(plans.page, plans.pageSize);
      if (detail?.id === id) await openDetail(id);
    } catch (error) {
      toast.error("控制计划失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function openDetail(id: string) {
    setBusy(`detail:${id}`);
    try {
      const payload = await requestJson<{ plan: typeof detail }>(`/api/admin/pipelines/plans/${id}`);
      setDetail(payload.plan);
    } catch (error) {
      toast.error("读取计划进度失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function updateSchedule(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/pipelines/schedules/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      await loadSchedules(schedules.page, schedules.pageSize);
    } catch (error) {
      toast.error("更新计划任务失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function removeSchedule(id: string) {
    setBusy(id);
    try {
      await requestJson(`/api/admin/pipelines/schedules/${id}`, { method: "DELETE" });
      await loadSchedules(schedules.page, schedules.pageSize);
    } catch (error) {
      toast.error("删除计划任务失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  async function runDue() {
    setBusy("due");
    try {
      const payload = await requestJson<{ created: number; planIds: string[] }>("/api/admin/pipelines/run-due", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }),
      });
      await Promise.all([
        loadSchedules(schedules.page, schedules.pageSize),
        loadPlans(plans.page, plans.pageSize),
      ]);
      toast.success(`已安全触发 ${payload.created} 个到期计划`, "重复调用不会重复领取同一到期任务。" );
    } catch (error) {
      toast.error("运行到期任务失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(""); }
  }

  const selectedTemplate = editor?.itemId ? templates.items.find((item) => item.id === editor.itemId) : undefined;

  return (
    <Grid gap="base">
      <Banner
        variant="default"
        title="每日自动产出已接入后台调度"
        description="默认计划每 1440 分钟创建 10 个音频任务；服务端每分钟领取到期任务。模型仍固定 music-3.0-free，全局 3 RPM，人工复审与发布门禁不会被绕过。"
      />
      <Tabs variant="underline" value={tab} onValueChange={(value) => setTab(value as Tab)} tabs={[
        { value: "templates", label: "模板" },
        { value: "plans", label: "计划" },
        { value: "schedules", label: "计划任务" },
      ]} />

      {tab === "templates" && (
        <ConsoleSection title="流水线模板" status={role === "admin" ? <Button size="sm" onClick={() => { setTemplateKey("knowledge-to-song-mock"); setTemplateName("知识到歌曲 Mock 流水线"); setTemplateDescription("Mock 知识扩写、WAV 候选、媒体检查与人工复审。"); setEditor({ kind: "template" }); }}>新建模板</Button> : undefined}>
          <Table>
            <thead><tr><th>模板</th><th>修订</th><th>阶段</th><th>状态</th><th>更新</th><th>操作</th></tr></thead>
            <tbody>
              {templates.items.map((item) => (
                <tr key={item.id}>
                  <td><Text bold>{item.name}</Text><Text variant="mono-secondary">{item.templateKey}</Text></td>
                  <td>v{item.currentRevision}</td>
                  <td>{item.stages.map((stage) => stage.label).join(" → ")}</td>
                  <td><Badge variant={item.status === "active" ? "success" : "neutral"}>{STATUS_LABEL[item.status]}</Badge></td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td><Grid gap="sm">
                    {role === "admin" && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { setTemplateName(item.name); setTemplateDescription(item.description); setEditor({ kind: "template-edit", itemId: item.id }); }}>编辑</Button>}
                    {role === "admin" && item.status !== "retired" && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setEditor({ kind: "revision", itemId: item.id })}>新修订</Button>}
                    {role === "admin" && item.status === "active" && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => updateTemplateStatus(item, "retired")}>退役</Button>}
                    {role === "admin" && item.status === "draft" && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => removeTemplate(item)}>删除</Button>}
                  </Grid></td>
                </tr>
              ))}
              {!templates.items.length && <tr><td colSpan={6}><Text variant="secondary">还没有模板。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination
            page={templates.page}
            pageSize={templates.pageSize}
            total={templates.total}
            onPage={(page) => setTemplates((current) => ({ ...current, page }))}
            onPageSize={(pageSize) => setTemplates((current) => ({ ...current, page: 1, pageSize }))}
          />
        </ConsoleSection>
      )}

      {tab === "plans" && (
        <ConsoleSection title="流水线计划" status={role === "admin" ? <Button size="sm" disabled={!revisions.length} onClick={() => { setRevisionId(revisions[0]?.value ?? ""); setEditor({ kind: "plan" }); }}>新建计划</Button> : undefined}>
          <Table>
            <thead><tr><th>计划</th><th>模板</th><th>状态</th><th>尝试</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {plans.items.map((item) => (
                <tr key={item.id}>
                  <td><Text bold>{item.name}</Text><Text variant="mono-secondary">mock={String(item.mockEnabled)}</Text></td>
                  <td>{item.templateName} · v{item.revision}</td>
                  <td><Badge variant={item.status === "succeeded" ? "success" : item.status === "failed" ? "error" : "neutral"}>{STATUS_LABEL[item.status] ?? item.status}</Badge>{item.error ? <Text variant="secondary">{item.error}</Text> : null}</td>
                  <td>{item.attempt}</td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td><Grid gap="sm">
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => openDetail(item.id)}>进度</Button>
                    {role === "admin" && ["queued", "running", "retry_wait"].includes(item.status) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => controlPlan(item.id, "pause")}>暂停</Button>}
                    {role === "admin" && ["paused", "draft"].includes(item.status) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => controlPlan(item.id, "resume")}>恢复</Button>}
                    {role === "admin" && !["succeeded", "failed", "cancelled"].includes(item.status) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => controlPlan(item.id, "cancel")}>取消</Button>}
                    {role === "admin" && ["failed", "cancelled"].includes(item.status) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => controlPlan(item.id, "retry")}>新尝试</Button>}
                    {item.status === "awaiting_review" && <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => controlPlan(item.id, "approve_review")}>确认复审（不发布）</Button>}
                  </Grid></td>
                </tr>
              ))}
              {!plans.items.length && <tr><td colSpan={6}><Text variant="secondary">还没有计划。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination
            page={plans.page}
            pageSize={plans.pageSize}
            total={plans.total}
            onPage={(page) => setPlans((current) => ({ ...current, page }))}
            onPageSize={(pageSize) => setPlans((current) => ({ ...current, page: 1, pageSize }))}
          />
        </ConsoleSection>
      )}

      {tab === "schedules" && (
        <ConsoleSection title="自动产出计划" status={role === "admin" ? <Grid gap="sm"><Button size="sm" disabled={!revisions.length || Boolean(busy)} onClick={() => { setRevisionId(revisions[0]?.value ?? ""); setEditor({ kind: "schedule" }); }}>新建任务</Button><Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={runDue}>运行到期任务</Button></Grid> : undefined}>
          <Table>
            <thead><tr><th>任务</th><th>模板</th><th>频率 / 数量</th><th>下次运行</th><th>上次运行</th><th>操作</th></tr></thead>
            <tbody>
              {schedules.items.map((item) => (
                <tr key={item.id}>
                  <td><Text bold>{item.name}</Text><Text variant="secondary">创建：{item.planName}</Text></td>
                  <td>{item.templateName} · v{item.revision}</td>
                  <td><Text>{item.intervalMinutes === 1440 ? "每天" : `${item.intervalMinutes} 分钟`}</Text><Text variant="secondary">每次 {item.batchSize} 个音频</Text></td>
                  <td>{formatTime(item.nextRunAt)}</td>
                  <td>{formatTime(item.lastRunAt)}</td>
                  <td>{role === "admin" && <Grid gap="sm"><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => updateSchedule(item.id, !item.enabled)}>{item.enabled ? "停用" : "启用"}</Button><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => removeSchedule(item.id)}>删除</Button></Grid>}</td>
                </tr>
              ))}
              {!schedules.items.length && <tr><td colSpan={6}><Text variant="secondary">还没有计划任务。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination
            page={schedules.page}
            pageSize={schedules.pageSize}
            total={schedules.total}
            onPage={(page) => setSchedules((current) => ({ ...current, page }))}
            onPageSize={(pageSize) => setSchedules((current) => ({ ...current, page: 1, pageSize }))}
          />
        </ConsoleSection>
      )}

      <ConsoleDrawer open={Boolean(editor)} onOpenChange={(open) => { if (!open) setEditor(null); }} title={editor?.kind === "plan" ? "新建流水线计划" : editor?.kind === "schedule" ? "新建间隔计划任务" : editor?.kind === "revision" ? "创建模板修订" : editor?.kind === "template-edit" ? "编辑模板" : "新建流水线模板"} description="服务端固定 Mock provider、music-3.0-free 和全局 3 RPM。">
        <Grid gap="base">
          {(editor?.kind === "template" || editor?.kind === "template-edit") && <>
            {editor.kind === "template" && <Input label="模板 key" value={templateKey} onValueChange={setTemplateKey} />}
            <Input label="模板名称" value={templateName} onValueChange={setTemplateName} />
            <Input label="说明" value={templateDescription} onValueChange={setTemplateDescription} />
            <Text variant="secondary">固定阶段：{DEFAULT_STAGES.map((stage) => stage.label).join(" → ")}</Text>
            <Button disabled={busy === "template"} onClick={createOrUpdateTemplate}>{busy === "template" ? "保存中…" : "保存模板"}</Button>
          </>}
          {editor?.kind === "revision" && <>
            <Text>{selectedTemplate?.name ?? "模板"} 将以固定五阶段创建新修订；历史修订不会被覆盖。</Text>
            <Button disabled={busy === "revision"} onClick={createRevision}>{busy === "revision" ? "创建中…" : "创建新修订"}</Button>
          </>}
          {editor?.kind === "plan" && <>
            <Select label="模板修订" value={revisionId} items={revisions} onValueChange={(value) => value && setRevisionId(value)} />
            <Input label="计划名称" value={planName} onValueChange={setPlanName} />
            <Input label="主题" value={planTheme} onValueChange={setPlanTheme} />
            <Button disabled={busy === "plan" || !revisionId || !planName.trim() || !planTheme.trim()} onClick={createPlan}>{busy === "plan" ? "创建中…" : "创建并执行"}</Button>
          </>}
          {editor?.kind === "schedule" && <>
            <Select label="模板修订" value={revisionId} items={revisions} onValueChange={(value) => value && setRevisionId(value)} />
            <Input label="任务名称" value={scheduleName} onValueChange={setScheduleName} />
            <Input label="创建的计划名称" value={schedulePlanName} onValueChange={setSchedulePlanName} />
            <Input label="主题" value={planTheme} onValueChange={setPlanTheme} />
            <Grid variant="2up" gap="sm">
              <GridItem><Input label="间隔（分钟）" description="每天固定为 1440 分钟。" type="number" min={1} max={10080} value={intervalMinutes} onValueChange={setIntervalMinutes} /></GridItem>
              <GridItem><Input label="每次音频数" type="number" min={1} max={20} value={batchSize} onValueChange={setBatchSize} /></GridItem>
            </Grid>
            <Button disabled={busy === "schedule" || !revisionId || Number(batchSize) < 1 || Number(batchSize) > 20} onClick={createSchedule}>{busy === "schedule" ? "创建中…" : "创建任务"}</Button>
          </>}
        </Grid>
      </ConsoleDrawer>

      <ConsoleDrawer open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }} title={detail?.name ?? "计划进度"} description={detail ? STATUS_LABEL[detail.status] ?? detail.status : ""}>
        {detail && <Grid gap="base">
          <ConsoleSection title="阶段进度">
            <Table><thead><tr><th>阶段</th><th>状态</th><th>检查点</th><th>错误</th></tr></thead><tbody>
              {detail.stages.map((stage) => <tr key={stage.stageKey}><td>{stage.stageKey}</td><td>{STATUS_LABEL[stage.status] ?? stage.status}</td><td><Text variant="mono-secondary">{JSON.stringify(stage.checkpoint).slice(0, 220)}</Text></td><td>{stage.error || "—"}</td></tr>)}
            </tbody></Table>
          </ConsoleSection>
          <ConsoleSection title="事件与 Mock 通知 sink">
            <Table><thead><tr><th>事件</th><th>时间</th></tr></thead><tbody>
              {detail.events.map((event) => <tr key={event.id}><td>{event.eventType}</td><td>{formatTime(event.createdAt)}</td></tr>)}
            </tbody></Table>
          </ConsoleSection>
        </Grid>}
      </ConsoleDrawer>
    </Grid>
  );
}
