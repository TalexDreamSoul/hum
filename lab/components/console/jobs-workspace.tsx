"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Grid, GridItem, Input, InputArea, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import {
  JOB_KIND_LABELS,
  JOB_STAGE_STATUS_LABELS,
  type JobArtifact,
  type JobAudioData,
  type JobFieldsData,
  type JobKind,
  type JobPointsData,
  type JobRecord,
  type JobScoresData,
  type JobStageView,
  type JobTextData,
} from "@/lib/jobs";
import { isProductionRunWaiting, productionRunConfirmation, productionRunStateOf } from "@/lib/production-run";
import { THEME_AGE_BAND_ITEMS, THEME_SCENE_ITEMS, type ThemeAgeBand, type ThemeScene } from "@/lib/theme-song";

const STATUS_LABEL: Record<string, string> = { running: "进行中", succeeded: "成功", failed: "失败" };

interface JobDetail {
  job: JobRecord;
  pipeline: JobStageView[];
  history: JobRecord[];
}

interface ThemeInput {
  theme: string;
  ageBand: ThemeAgeBand;
  scene: ThemeScene;
  sourceNotes: string;
}

function statusVariant(status: string) {
  return status === "succeeded" ? "success" : status === "failed" ? "warning" : "info";
}

function stageVariant(status: JobStageView["status"]) {
  if (status === "done") return "success";
  if (status === "failed" || status === "blocked") return "warning";
  if (status === "running" || status === "waiting") return "info";
  return "neutral";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function kindLabel(kind: JobKind): string {
  return JOB_KIND_LABELS[kind] ?? kind;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function themeInputOf(job: JobRecord): ThemeInput {
  const input = (job.input ?? {}) as Partial<ThemeInput>;
  return {
    theme: typeof input.theme === "string" ? input.theme : "",
    ageBand: THEME_AGE_BAND_ITEMS.some((item) => item.value === input.ageBand) ? input.ageBand as ThemeAgeBand : "5-6",
    scene: THEME_SCENE_ITEMS.some((item) => item.value === input.scene) ? input.scene as ThemeScene : "commute",
    sourceNotes: typeof input.sourceNotes === "string" ? input.sourceNotes : "",
  };
}

/** 按产物类型渲染：字段表、知识点表、文本、音频、评分，都不给人看 JSON。 */
function ArtifactView({ artifact }: { artifact: JobArtifact }) {
  const data = artifact.data;
  if (!data || typeof data !== "object") return null;

  if (artifact.kind === "fields") {
    const fields = (data as unknown as JobFieldsData).fields ?? [];
    return (
      <Grid variant="2up" gap="sm">
        {fields.map((field, index) => (
          <GridItem key={`${field.label}-${index}`}>
            <Text variant="secondary">{field.label}</Text>
            <Text>{field.value || "—"}</Text>
          </GridItem>
        ))}
      </Grid>
    );
  }

  if (artifact.kind === "points") {
    const points = (data as unknown as JobPointsData).points ?? [];
    return (
      <Table>
        <thead><tr><th>提示句</th><th>句尾答案</th><th>接唱提示</th></tr></thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.answer}-${index}`}>
              <td>{point.lead}</td>
              <td><Text bold>{point.answer}</Text></td>
              <td>{point.cue}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }

  if (artifact.kind === "text") {
    const text = (data as unknown as JobTextData).text ?? "";
    return <InputArea label={artifact.title} value={text} readOnly autoResize minRows={3} maxRows={20} />;
  }

  if (artifact.kind === "audio") {
    const audio = data as unknown as JobAudioData;
    return (
      <Grid gap="sm">
        <Text variant="secondary">{audio.label}</Text>
        <audio controls preload="metadata" src={audio.url} />
      </Grid>
    );
  }

  const scores = data as unknown as JobScoresData;
  return (
    <Grid gap="sm">
      <Grid variant="4up" gap="sm">
        <GridItem><Text variant="secondary">总分</Text><Text bold>{scores.total ?? "—"} / 100</Text></GridItem>
        <GridItem><Text variant="secondary">等级</Text><Text>{scores.grade ?? "—"}</Text></GridItem>
        <GridItem><Text variant="secondary">门槛</Text><Text>{scores.threshold} 分</Text></GridItem>
        <GridItem><Text variant="secondary">结论</Text><Badge variant={scores.passed ? "success" : "warning"}>{scores.passed ? "通过" : "未通过"}</Badge></GridItem>
      </Grid>
      <Table>
        <thead><tr><th>维度</th><th>分数</th><th>说明</th></tr></thead>
        <tbody>
          {(scores.dims ?? []).map((dim, index) => (
            <tr key={`${dim.label}-${index}`}>
              <td>{dim.label}</td>
              <td>{dim.score ?? "不适用"}</td>
              <td>{dim.detail}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Grid>
  );
}

function PipelineTable({ pipeline }: { pipeline: JobStageView[] }) {
  const stuck = pipeline.find((stage) => stage.status === "blocked" || stage.status === "failed");
  return (
    <Grid gap="sm">
      {stuck && <Banner variant="alert" title={`卡在「${stuck.stage}」`} description={stuck.note ?? "这一步没有完成"} />}
      <Table>
        <thead><tr><th>阶段</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>
          {pipeline.map((stage, index) => (
            <tr key={stage.stage}>
              <td>{index + 1}. {stage.stage}</td>
              <td><Badge variant={stageVariant(stage.status)}>{JOB_STAGE_STATUS_LABELS[stage.status]}</Badge></td>
              <td>{stage.note ?? (stage.status === "done" ? "—" : "尚未执行")}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Grid>
  );
}

function StageArtifacts({ artifacts, stage }: { artifacts: JobArtifact[]; stage: string }) {
  const current = artifacts.filter((artifact) => artifact.stage === stage);
  if (!current.length) return <Text variant="secondary">这个阶段还没有产物。</Text>;

  return (
    <Grid gap="base">
      {current.map((artifact, index) => (
        <Grid key={`${artifact.title}-${index}`} gap="sm">
          {artifact.kind !== "text" && <Text bold>{artifact.title}</Text>}
          <ArtifactView artifact={artifact} />
        </Grid>
      ))}
    </Grid>
  );
}

export function JobsWorkspace() {
  const toast = useConsoleToast();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [selectedStage, setSelectedStage] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ThemeInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const openId = useRef("");

  const loadDetail = useCallback(async (id: string, resetStage = false) => {
    const response = await fetch(`/api/admin/jobs/${id}`, { cache: "no-store" });
    const payload = await response.json() as JobDetail & { error?: string };
    if (!response.ok) throw new Error(payload.error || "读取任务详情失败");
    const activeStage = payload.pipeline.find((stage) =>
      stage.status === "waiting" || stage.status === "running" || stage.status === "failed" || stage.status === "blocked",
    )?.stage;
    const latestStage = [...payload.pipeline].reverse().find((stage) => stage.status === "done")?.stage;
    const fallbackStage = activeStage ?? latestStage ?? payload.pipeline[0]?.stage ?? "";
    openId.current = id;
    setDetail(payload);
    setSelectedStage((current) => resetStage || !payload.pipeline.some((stage) => stage.stage === current) ? fallbackStage : current);
    return payload;
  }, []);

  const refresh = useCallback(async (targetPage = page, targetSize = pageSize) => {
    const response = await fetch(`/api/admin/jobs?page=${targetPage}&pageSize=${targetSize}`, { cache: "no-store" });
    const payload = await response.json() as { jobs?: JobRecord[]; total?: number; page?: number; error?: string };
    if (!response.ok) throw new Error(payload.error || "读取任务失败");
    setJobs(payload.jobs ?? []);
    setTotal(payload.total ?? 0);
    if (payload.page && payload.page !== targetPage) setPage(payload.page);
    if (openId.current) await loadDetail(openId.current);
  }, [page, pageSize, loadDetail]);

  useEffect(() => {
    refresh(page, pageSize).catch((error) => toast.error("读取任务失败", error.message)).finally(() => setLoading(false));
  }, [page, pageSize]);

  // 有任务在跑时轮询，全部结束后停下，避免后台一直打接口。
  const hasRunning = jobs.some((job) => job.status === "running" && !isProductionRunWaiting(job.output));
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => { refresh().catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  async function openDrawer(id: string) {
    try {
      const payload = await loadDetail(id, true);
      setEditing(payload.job.kind === "theme_plan" ? themeInputOf(payload.job) : null);
      setDrawerOpen(true);
    } catch (error) {
      toast.error("读取任务详情失败", error instanceof Error ? error.message : undefined);
    }
  }

  async function advanceProduction() {
    if (!detail) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/production-runs/${detail.job.id}/advance`, { method: "POST" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "继续任务失败");
      await refresh();
      toast.success("已确认，任务继续运行", "后续进展会自动写入当前阶段详情");
    } catch (error) {
      toast.error("继续任务失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function retry(useEdited: boolean) {
    if (!detail) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/jobs/${detail.job.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(useEdited && editing ? { input: editing } : {}),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "重跑失败");
      await refresh();
      const latest = await fetch(`/api/admin/jobs?page=1&pageSize=1`, { cache: "no-store" })
        .then((res) => res.json() as Promise<{ jobs?: JobRecord[] }>);
      const newest = latest.jobs?.[0];
      if (newest) await loadDetail(newest.id);
      toast.success(useEdited ? "已用修改后的参数重跑" : "已按原参数重跑", "旧版本快照保留在运行历史里");
    } catch (error) {
      toast.error("重跑失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Text variant="secondary">正在读取任务…</Text>;

  const job = detail?.job;
  const runIndex = detail ? detail.history.findIndex((run) => run.id === detail.job.id) + 1 : 0;
  const productionState = job?.kind === "production_run" ? productionRunStateOf(job.output) : null;
  const confirmation = productionRunConfirmation(productionState);
  const selectedStageView = detail?.pipeline.find((stage) => stage.stage === selectedStage) ?? null;
  const detailStatusLabel = job
    ? confirmation ? "待确认" : STATUS_LABEL[job.status] ?? job.status
    : "";

  return (
    <Grid gap="base">
      <ConsoleSection
        title="任务列表"
        status={<Button type="button" size="sm" variant="secondary" onClick={() => refresh().catch((error) => toast.error("刷新失败", error.message))}>刷新</Button>}
      >
        <Grid gap="sm">
          <Table>
            <thead><tr><th>类型</th><th>任务</th><th>状态</th><th>耗时</th><th>发起</th><th>开始时间</th><th>操作</th></tr></thead>
            <tbody>
              {jobs.map((item) => (
                <tr key={item.id}>
                  <td><Badge variant="neutral">{kindLabel(item.kind)}</Badge></td>
                  <td><Text bold>{item.title}</Text><Text variant="secondary">{item.steps.at(-1)?.message ?? "—"}</Text></td>
                  <td><Badge variant={statusVariant(item.status)}>{isProductionRunWaiting(item.output) ? "待确认" : STATUS_LABEL[item.status] ?? item.status}</Badge></td>
                  <td>{formatDuration(item.durationMs)}</td>
                  <td>{item.actorName ?? "—"}</td>
                  <td>{formatTime(item.createdAt)}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => openDrawer(item.id)}>查看详情</Button></td>
                </tr>
              ))}
              {!jobs.length && <tr><td colSpan={7}><Text variant="secondary">还没有任务。主题拆解、候选生成和模型测试都会记录在这里。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={total}
            onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer
        open={drawerOpen}
        onOpenChange={(open) => { setDrawerOpen(open); if (!open) openId.current = ""; }}
        title={job?.title ?? ""}
        description={job ? `第 ${runIndex || 1} 次运行 · ${kindLabel(job.kind)} · ${detailStatusLabel} · 耗时 ${formatDuration(job.durationMs)}` : ""}
      >
          {job && detail && (
            <Grid gap="base">

              {job.error && <Banner variant="alert" title="任务失败" description={job.error} />}
              {confirmation && (
                <ConsoleSection title="等待你的确认" status={<Badge variant="info">{confirmation.stage}</Badge>}>
                  <Grid gap="sm">
                    <Text>{confirmation.description}</Text>
                    <Button type="button" disabled={busy} onClick={advanceProduction}>
                      {busy ? "正在继续…" : confirmation.action}
                    </Button>
                  </Grid>
                </ConsoleSection>
              )}

              <ConsoleSection title="流程">
                <PipelineTable pipeline={detail.pipeline} />
              </ConsoleSection>

              <ConsoleSection
                title="阶段详情"
                status={selectedStageView ? <Badge variant={stageVariant(selectedStageView.status)}>{JOB_STAGE_STATUS_LABELS[selectedStageView.status]}</Badge> : undefined}
              >
                <Grid gap="base">
                  <Select
                    label="查看阶段"
                    value={selectedStage}
                    items={detail.pipeline.map((stage) => ({
                      value: stage.stage,
                      label: `${stage.stage} · ${JOB_STAGE_STATUS_LABELS[stage.status]}`,
                    }))}
                    onValueChange={(value: string | null) => value && setSelectedStage(value)}
                    renderValue={(value: string) => detail.pipeline.find((stage) => stage.stage === value)?.stage ?? value}
                  />
                  {selectedStageView?.note && <Banner variant={selectedStageView.status === "failed" || selectedStageView.status === "blocked" ? "alert" : "default"} title={selectedStageView.note} />}
                  <StageArtifacts artifacts={job.artifacts} stage={selectedStage} />
                </Grid>
              </ConsoleSection>

              <ConsoleSection title="重跑与修改">
                <Grid gap="sm">
                  {job.kind === "theme_plan" && editing ? (
                    <>
                      <Input label="学习主题" value={editing.theme}
                        onValueChange={(value) => setEditing({ ...editing, theme: value })} />
                      <Grid variant="2up" gap="sm">
                        <GridItem>
                          <Select label="年龄段" value={editing.ageBand} items={[...THEME_AGE_BAND_ITEMS]}
                            onValueChange={(value: ThemeAgeBand | null) => value && setEditing({ ...editing, ageBand: value })}
                            renderValue={(value: ThemeAgeBand) => THEME_AGE_BAND_ITEMS.find((item) => item.value === value)?.label ?? value} />
                        </GridItem>
                        <GridItem>
                          <Select label="使用场景" value={editing.scene} items={[...THEME_SCENE_ITEMS]}
                            onValueChange={(value: ThemeScene | null) => value && setEditing({ ...editing, scene: value })}
                            renderValue={(value: ThemeScene) => THEME_SCENE_ITEMS.find((item) => item.value === value)?.label ?? value} />
                        </GridItem>
                      </Grid>
                      <InputArea label="教材或核验资料" value={editing.sourceNotes} autoResize minRows={2} maxRows={8}
                        onValueChange={(value) => setEditing({ ...editing, sourceNotes: value })} />
                      <Grid variant="2up" gap="sm">
                        <GridItem><Button type="button" disabled={busy} onClick={() => retry(true)}>{busy ? "正在重跑…" : "用修改后的参数重跑"}</Button></GridItem>
                        <GridItem><Button type="button" variant="secondary" disabled={busy} onClick={() => retry(false)}>按原参数重跑</Button></GridItem>
                      </Grid>
                    </>
                  ) : job.kind === "production_run" ? (
                    <Text variant="secondary">创作任务按阶段流转；等待中的任务请在上方确认，失败后从生产页重新发起并保留本次快照。</Text>
                  ) : job.kind === "music_test" ? (
                    <Text variant="secondary">模型测试的 prompt 和歌词不落库，重跑请回模型实验室。</Text>
                  ) : (
                    <Button type="button" disabled={busy} onClick={() => retry(false)}>{busy ? "正在重跑…" : "按原参数重跑"}</Button>
                  )}
                </Grid>
              </ConsoleSection>

              <ConsoleSection title={`运行历史（${detail.history.length}）`}>
                <Table>
                  <thead><tr><th>次序</th><th>状态</th><th>耗时</th><th>时间</th><th>操作</th></tr></thead>
                  <tbody>
                    {detail.history.map((run, index) => (
                      <tr key={run.id}>
                        <td>第 {index + 1} 次{run.id === job.id ? "（当前）" : ""}</td>
                        <td><Badge variant={statusVariant(run.status)}>{STATUS_LABEL[run.status] ?? run.status}</Badge></td>
                        <td>{formatDuration(run.durationMs)}</td>
                        <td>{formatTime(run.createdAt)}</td>
                        <td>
                          <Button size="sm" variant="ghost" disabled={run.id === job.id}
                            onClick={() => loadDetail(run.id).catch((error) => toast.error("读取快照失败", error.message))}>
                            查看快照
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </ConsoleSection>

              <ConsoleSection title="执行过程">
                <Grid gap="sm">
                  <Table>
                    <thead><tr><th>时刻</th><th>距开始</th><th>进展</th><th>详情</th></tr></thead>
                    <tbody>
                      {job.steps.map((step, index) => (
                        <tr key={`${step.at}-${index}`}>
                          <td>{new Date(step.at).toLocaleTimeString("zh-CN")}</td>
                          <td>{formatDuration(step.at - job.createdAt)}</td>
                          <td>{step.message}</td>
                          <td><Text variant="mono-secondary">{step.detail ?? "—"}</Text></td>
                        </tr>
                      ))}
                      {!job.steps.length && <tr><td colSpan={4}><Text variant="secondary">任务还没有写入进展。</Text></td></tr>}
                    </tbody>
                  </Table>
                  <InputArea label="原始输入" value={pretty(job.input)} readOnly autoResize minRows={2} maxRows={8} />
                  <InputArea label="原始输出" value={pretty(job.output) || "（无输出）"} readOnly autoResize minRows={2} maxRows={10} />
                  <Text variant="mono-secondary">任务 ID：{job.id}</Text>
                </Grid>
              </ConsoleSection>
            </Grid>
          )}
      </ConsoleDrawer>
    </Grid>
  );
}
