"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Grid, GridItem, Input, InputArea, LinkButton, Select, Table, Tabs, Text } from "@cloudflare/kumo";
import { CandidatePlayer } from "@/components/console/candidate-player";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, pageSlice, useConsoleToast } from "@/components/console/console-ui";
import { DimensionRadar, ScoreTrend, type DimPoint } from "@/components/console/score-charts";
import { SongSpecEditor } from "@/components/console/song-spec-editor";
import { ThemeSongWizard } from "@/components/console/theme-song-wizard";
import { MINIMAX_MUSIC_MODEL_LABELS, type MiniMaxBatchModel } from "@/lib/minimax";
import type { LyricLineTiming } from "@/lib/analysis/lyrics-timeline";
import type { JobRecord } from "@/lib/jobs";
import { productionRunStateOf } from "@/lib/production-run";
import { diagnose, type DoctorDim, type DoctorPlan } from "@/lib/prompt-doctor";
import { buildSongSpecLyrics, buildSongSpecPrompt } from "@/lib/song-spec";
import type { CandidateDetail } from "@/lib/server/candidate-review";
import type { CandidateSummary, ExperimentBatchSummary } from "@/lib/server/experiments";
import type { StoredSongSpec } from "@/lib/server/song-specs";

type CreationMode = "theme" | "spec";
type RecordDetailStage = "spec" | "generation" | "review";
type HistoryStage = "revisions" | "batches" | "candidates";
type ReviewKind = "content" | "music";
type ReviewVerdict = "pass" | "fail" | "needs_inpaint";
type StageKey =
  | "planning"
  | "await_knowledge"
  | "approving"
  | "await_generation"
  | "generating"
  | "draft"
  | "spec_review"
  | "ready"
  | "failed"
  | "qc_failed"
  | "review"
  | "mastered"
  | "retired";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  spec_review: "规格审核",
  approved: "已批准",
  retired: "已退役",
  generating: "生成中",
  human_review: "人工评审",
  completed: "已完成",
  failed: "失败",
  pending: "等待生成",
  generated: "待评审",
  rejected: "已淘汰",
  needs_inpaint: "需要重绘",
};

/** 一首歌在流水线上的位置：列表只显示这一个状态，细节都在详情里。 */
const STAGE_LABEL: Record<StageKey, string> = {
  planning: "拆解中",
  await_knowledge: "等待确认知识",
  approving: "批准规格中",
  await_generation: "等待生成",
  generating: "生成中",
  draft: "草稿待提交",
  spec_review: "等待批准规格",
  ready: "待生成候选",
  failed: "生成失败",
  qc_failed: "质检未通过",
  review: "待人工评审",
  mastered: "已出母带",
  retired: "已退役",
};

const STAGE_ITEMS = [
  { value: "all", label: "全部" },
  ...(Object.keys(STAGE_LABEL) as StageKey[]).map((value) => ({ value, label: STAGE_LABEL[value] })),
] as const;

const REVIEW_KIND_ITEMS = [
  { value: "content", label: "内容评审" },
  { value: "music", label: "音乐评审" },
] as const;

const REVIEW_VERDICT_ITEMS = [
  { value: "pass", label: "通过" },
  { value: "fail", label: "不通过" },
  { value: "needs_inpaint", label: "需要重绘" },
] as const;

const WAITING_STAGES: StageKey[] = ["await_knowledge", "await_generation"];
const RUNNING_STAGES: StageKey[] = ["planning", "approving", "generating"];

function StageBadge({ stage }: { stage: StageKey }) {
  const variant = stage === "mastered" ? "success"
    : stage === "failed" || stage === "qc_failed" ? "warning"
      : WAITING_STAGES.includes(stage) ? "warning"
        : RUNNING_STAGES.includes(stage) || stage === "review" || stage === "spec_review" ? "info"
          : "neutral";
  return <Badge variant={variant}>{STAGE_LABEL[stage]}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "approved" || status === "completed" || status === "generated"
    ? "success"
    : status === "failed" || status === "rejected"
      ? "warning"
      : status === "spec_review" || status === "human_review"
        ? "info"
        : "neutral";
  return <Badge variant={variant}>{STATUS_LABEL[status] ?? status}</Badge>;
}

function formatDate(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(1)} 秒`;
}

function formatCost(value: number | null): string {
  return value === null ? "—" : value === 0 ? "0.0" : `${(value / 1_000_000).toFixed(4)}`;
}

function modelLabel(model: string): string {
  return MINIMAX_MUSIC_MODEL_LABELS[model as keyof typeof MINIMAX_MUSIC_MODEL_LABELS] ?? model;
}

function formatAudioMetadata(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const metadata = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof metadata.durationMs === "number") parts.push(`${Math.round(metadata.durationMs / 1000)} 秒`);
  if (typeof metadata.sampleRate === "number") parts.push(`${(metadata.sampleRate / 1000).toFixed(1)} kHz`);
  if (typeof metadata.channels === "number") parts.push(`${metadata.channels} 声道`);
  if (typeof metadata.sizeBytes === "number") parts.push(`${(metadata.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(" · ");
}

function latestReview(detail: CandidateDetail, kind: string) {
  return [...detail.reviews].reverse().find((review) => review.reviewKind === kind);
}

function canApproveMaster(detail: CandidateDetail): boolean {
  const automatic = latestReview(detail, "auto");
  const content = latestReview(detail, "content");
  const music = latestReview(detail, "music");
  return detail.status === "generated"
    && automatic?.verdict === "pass"
    && content?.verdict === "pass"
    && music?.verdict === "pass"
    && Boolean(content.reviewerId && music.reviewerId && content.reviewerId !== music.reviewerId);
}

/** 一首歌的全部家当：规格的每个修订、每次批次、每个候选，都挂在同一条记录下。 */
interface SongRecord {
  specKey: string;
  title: string;
  /** 关联的在途创作任务；有它时阶段以任务为准 */
  runId?: string;
  latest: StoredSongSpec;
  revisions: StoredSongSpec[];
  batches: ExperimentBatchSummary[];
  candidates: CandidateSummary[];
  stage: StageKey;
  updatedAt: number;
}

/** 还没产出 SongSpec 的创作任务，也要在流水线里占一行。 */
export interface PendingRunRow {
  runId: string;
  title: string;
  stage: StageKey;
  updatedAt: number;
}

const PHASE_STAGE: Record<string, StageKey> = {
  queued_plan: "planning",
  running_plan: "planning",
  waiting_plan: "await_knowledge",
  queued_approval: "approving",
  running_approval: "approving",
  waiting_generation: "await_generation",
  queued_generation: "generating",
  running_generation: "generating",
};

function runStage(job: JobRecord): StageKey | null {
  const state = productionRunStateOf(job.output);
  if (!state) return job.status === "running" ? "planning" : null;
  return PHASE_STAGE[state.phase] ?? null;
}

function runSpecId(job: JobRecord): string | undefined {
  return productionRunStateOf(job.output)?.specId;
}

function buildSongRecords(specs: StoredSongSpec[], batches: ExperimentBatchSummary[], runs: JobRecord[] = []): SongRecord[] {
  const byKey = new Map<string, StoredSongSpec[]>();
  specs.forEach((spec) => {
    const list = byKey.get(spec.specKey) ?? [];
    list.push(spec);
    byKey.set(spec.specKey, list);
  });

  const records: SongRecord[] = [];
  byKey.forEach((revisions, specKey) => {
    const sorted = [...revisions].sort((a, b) => a.revision - b.revision);
    const latest = sorted[sorted.length - 1];
    const ids = new Set(sorted.map((spec) => spec.id));
    const relatedBatches = batches.filter((batch) => ids.has(batch.specId));
    const candidates = relatedBatches.flatMap((batch) => batch.candidates);

    const stage: StageKey = candidates.some((candidate) => candidate.status === "approved")
      ? "mastered"
      : candidates.some((candidate) => candidate.status === "generated")
        ? "review"
        : candidates.some((candidate) => candidate.status === "rejected")
          ? "qc_failed"
          : relatedBatches.length && candidates.every((candidate) => candidate.status === "failed")
            ? "failed"
          : latest.status === "approved"
            ? "ready"
            : latest.status === "spec_review"
              ? "spec_review"
              : latest.status === "retired"
                ? "retired"
                : "draft";

    records.push({
      specKey,
      title: latest.content.title,
      latest,
      revisions: sorted,
      batches: [...relatedBatches].sort((a, b) => b.createdAt - a.createdAt),
      candidates: [...candidates].sort((a, b) => b.createdAt - a.createdAt),
      stage,
      updatedAt: Math.max(latest.createdAt, ...relatedBatches.map((batch) => batch.updatedAt), 0),
    });
  });
  // 在途创作任务的阶段优先：任务还在跑时，列表要显示「等待生成」这类真实状态
  runs.forEach((job) => {
    // 任务已经结束（成功或失败）时不再覆盖阶段，让规格和候选的真实状态说话
    if (job.status !== "running") return;
    const stage = runStage(job);
    const specId = runSpecId(job);
    if (!stage || !specId) return;
    const record = records.find((item) => item.revisions.some((revision) => revision.id === specId));
    if (!record) return;
    record.stage = stage;
    record.runId = job.id;
    record.updatedAt = Math.max(record.updatedAt, job.updatedAt);
  });
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function buildPendingRuns(runs: JobRecord[]): PendingRunRow[] {
  return runs
    .filter((job) => job.status === "running" && !runSpecId(job))
    .map((job) => ({
      runId: job.id,
      title: (job.input as { theme?: string } | null)?.theme || job.title,
      stage: runStage(job) ?? "planning",
      updatedAt: job.updatedAt,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 自动 ReportCard：候选的评分结果，评审时最先看的东西。 */
function AutoReportCard({ detail }: { detail: CandidateDetail }) {
  const review = latestReview(detail, "auto");
  if (!review?.scores || typeof review.scores !== "object") {
    return <Text variant="secondary">这个候选没有自动评分——音频没有生成成功时不会评分。</Text>;
  }
  const scores = review.scores as Record<string, unknown>;
  const dims = Array.isArray(scores.dims)
    ? scores.dims.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  const findings = Array.isArray(scores.findings)
    ? scores.findings.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  const total = typeof scores.total === "number" ? scores.total : null;
  const grade = typeof scores.grade === "string" ? scores.grade : "—";
  const threshold = typeof scores.minimumPassScore === "number" ? scores.minimumPassScore : 70;
  const warning = findings.find((finding) => finding.tone === "bad") ?? findings.find((finding) => finding.tone === "warn");

  return (
    <Grid gap="sm">
      <Grid variant="4up" gap="sm">
        <GridItem><Text variant="secondary">总分</Text><Text bold>{total ?? "—"} / 100</Text></GridItem>
        <GridItem><Text variant="secondary">等级</Text><Text>{grade}</Text></GridItem>
        <GridItem><Text variant="secondary">通过门槛</Text><Text>{threshold} 分</Text></GridItem>
        <GridItem><Text variant="secondary">结论</Text><Badge variant={review.verdict === "pass" ? "success" : "warning"}>{review.verdict === "pass" ? "通过" : "未通过"}</Badge></GridItem>
      </Grid>
      {warning && typeof warning.text === "string" && <Banner variant="alert" title={warning.text} />}
      {dims.length > 0 && (
        <Table>
          <thead><tr><th>维度</th><th>分数</th><th>说明</th></tr></thead>
          <tbody>
            {dims.map((dim, index) => (
              <tr key={`${String(dim.key ?? "dim")}-${index}`}>
                <td>{String(dim.label ?? dim.key ?? "—")}</td>
                <td>{typeof dim.score === "number" ? dim.score : "不适用"}</td>
                <td>{String(dim.detail ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Grid>
  );
}

export function ProductionWorkspace({
  role,
  initialSongSpecs,
  initialBatches,
  ai,
  minimax,
}: {
  role: "admin" | "approver";
  initialSongSpecs: StoredSongSpec[];
  initialBatches: ExperimentBatchSummary[];
  ai: { ready: boolean; model: string };
  minimax: { ready: boolean; batchModel: MiniMaxBatchModel; requestsPerMinute: number };
}) {
  const toast = useConsoleToast();
  const [songSpecs, setSongSpecs] = useState(initialSongSpecs);
  const [batches, setBatches] = useState(initialBatches);
  const [runs, setRuns] = useState<JobRecord[]>([]);
  const [stageFilter, setStageFilter] = useState<StageKey | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [creationOpen, setCreationOpen] = useState(false);
  const [creationMode, setCreationMode] = useState<CreationMode>("theme");
  const [editor, setEditor] = useState<{ source?: StoredSongSpec } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detailStage, setDetailStage] = useState<RecordDetailStage>("spec");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyStage, setHistoryStage] = useState<HistoryStage>("revisions");
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [reviewKind, setReviewKind] = useState<ReviewKind>("content");
  const [reviewVerdict, setReviewVerdict] = useState<ReviewVerdict>("pass");
  const [reviewNotes, setReviewNotes] = useState("");
  const [busy, setBusy] = useState("");

  const records = useMemo(() => buildSongRecords(songSpecs, batches, runs), [songSpecs, batches, runs]);
  const pendingRuns = useMemo(() => buildPendingRuns(runs), [runs]);
  const openRecord = useMemo(() => records.find((record) => record.specKey === openKey) ?? null, [records, openKey]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (stageFilter !== "all" && record.stage !== stageFilter) return false;
      if (!needle) return true;
      return `${record.title} ${record.specKey} ${record.latest.content.scene}`.toLocaleLowerCase().includes(needle);
    });
  }, [records, search, stageFilter]);

  async function reload() {
    const [specResponse, batchResponse, runResponse] = await Promise.all([
      fetch("/api/admin/song-specs", { cache: "no-store" }),
      fetch("/api/admin/experiment-batches", { cache: "no-store" }),
      fetch("/api/admin/jobs?kind=production_run&pageSize=50", { cache: "no-store" }),
    ]);
    const specPayload = await specResponse.json() as { songSpecs?: StoredSongSpec[]; error?: string };
    const batchPayload = await batchResponse.json() as { batches?: ExperimentBatchSummary[]; error?: string };
    if (!specResponse.ok) throw new Error(specPayload.error || "读取 SongSpec 失败");
    if (!batchResponse.ok) throw new Error(batchPayload.error || "读取实验批次失败");
    setSongSpecs(specPayload.songSpecs ?? []);
    setBatches(batchPayload.batches ?? []);
    const runPayload = await runResponse.json().catch(() => ({})) as { jobs?: JobRecord[] };
    if (runResponse.ok) setRuns(runPayload.jobs ?? []);
  }

  async function transitionSpec(spec: StoredSongSpec, action: "submit" | "approve" | "retire") {
    setBusy(`spec:${spec.id}`);
    try {
      const response = await fetch(`/api/admin/song-specs/${spec.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { songSpec?: StoredSongSpec; error?: string };
      if (!response.ok || !payload.songSpec) throw new Error(payload.error || "更新 SongSpec 失败");
      await reload();
      toast.success(`已更新为“${STATUS_LABEL[payload.songSpec.status]}”`);
    } catch (error) {
      toast.error("更新 SongSpec 失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function generateCandidate(spec: StoredSongSpec, retry = false) {
    setBusy(`batch:${spec.id}`);
    try {
      const response = await fetch("/api/admin/experiment-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specId: spec.id }),
      });
      const payload = await response.json() as { batch?: ExperimentBatchSummary; error?: string };
      if (!response.ok || !payload.batch) throw new Error(payload.error || "生成候选失败");
      await reload();
      const candidate = payload.batch.candidates[0];
      if (candidate) await openCandidate(candidate.id);
      toast.success(retry ? "已重新生成候选" : "候选已生成并进入人工评审", "详细进展在任务队列里");
    } catch (error) {
      await reload();
      toast.error(retry ? "重新生成失败" : "生成候选失败", error instanceof Error ? error.message : "任务队列里有每一步的上游返回");
    } finally {
      setBusy("");
    }
  }

  async function openCandidate(id: string) {
    setBusy(`candidate:${id}`);
    try {
      const response = await fetch(`/api/admin/candidates/${id}`, { cache: "no-store" });
      const payload = await response.json() as { candidate?: CandidateDetail; error?: string };
      if (!response.ok || !payload.candidate) throw new Error(payload.error || "读取候选详情失败");
      setCandidateDetail(payload.candidate);
      setCandidateOpen(true);
    } catch (error) {
      toast.error("读取候选详情失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function improveCandidate(rounds: number) {
    if (!candidateDetail) return;
    setBusy(`improve:${candidateDetail.id}`);
    try {
      const response = await fetch(`/api/admin/candidates/${candidateDetail.id}/improve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rounds }),
      });
      const payload = await response.json() as { candidateId?: string; history?: Array<{ round: number; total: number | null; passed: boolean }>; error?: string };
      if (!response.ok || !payload.candidateId) throw new Error(payload.error || "按建议重生成失败");
      await reload();
      await openCandidate(payload.candidateId);
      const last = payload.history?.at(-1);
      toast.success(
        last?.passed ? `第 ${last.round} 轮通过，得分 ${last.total ?? "—"}` : `已重跑 ${payload.history?.length ?? 0} 轮，最新得分 ${last?.total ?? "—"}`,
        "每一轮的改法、提示词和模型请求都在任务队列里",
      );
    } catch (error) {
      toast.error("按建议重生成失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function actOnCandidate(input: Record<string, unknown>, successMessage: string) {
    if (!candidateDetail) return;
    setBusy(`candidate-action:${candidateDetail.id}`);
    try {
      const response = await fetch(`/api/admin/candidates/${candidateDetail.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await response.json() as { candidate?: CandidateDetail; error?: string };
      if (!response.ok || !payload.candidate) throw new Error(payload.error || "更新候选失败");
      setCandidateDetail(payload.candidate);
      setReviewNotes("");
      await reload();
      toast.success(successMessage);
    } catch (error) {
      toast.error("更新候选失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  // 创作只负责把记录建出来：弹窗关掉，后续步骤回到列表里点详情继续。
  function finishCreation(message: string, description?: string) {
    setCreationOpen(false);
    setEditor(null);
    reload()
      .then(() => toast.success(message, description))
      .catch((error) => toast.error("刷新列表失败", error instanceof Error ? error.message : undefined));
  }

  // 进页面先同步一次在途创作任务：服务端渲染只带了规格和批次
  useEffect(() => { reload().catch(() => undefined); }, []);

  // 有创作任务在跑就轮询，跑完停下
  const hasActiveRun = pendingRuns.length > 0 || records.some((record) => record.runId);
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => { reload().catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [hasActiveRun]);

  const latestCandidate = openRecord?.candidates[0] ?? null;
  // 候选用的歌词和提示词由它那一版规格确定性推出，报告页要能对着听
  const candidateSpec = candidateDetail
    ? songSpecs.find((spec) => spec.id === candidateDetail.specId) ?? null
    : null;
  const candidateLyrics = candidateSpec ? buildSongSpecLyrics(candidateSpec.content) : "";
  const candidatePrompt = candidateSpec ? buildSongSpecPrompt(candidateSpec.content) : undefined;
  // 质检时用留白检测反推的逐行时间轴，存在自动评审的 scores 里
  // ReportCard 没过门槛时，把判词翻译成下一轮的具体改法
  const candidateDoctor: DoctorPlan | null = (() => {
    if (!candidateDetail || !candidateSpec) return null;
    const auto = [...candidateDetail.reviews].reverse().find((review) => review.reviewKind === "auto");
    const scores = (auto?.scores ?? {}) as { total?: number | null; minimumPassScore?: number; dims?: DoctorDim[] };
    if (!Array.isArray(scores.dims) || !scores.dims.length) return null;
    if (auto?.verdict === "pass") return null;
    return diagnose({
      scene: candidateSpec.content.scene,
      total: scores.total ?? null,
      threshold: scores.minimumPassScore ?? 70,
      dims: scores.dims,
      music: {
        bpm: candidateSpec.content.music.bpm,
        lowestNote: candidateSpec.content.music.lowestNote,
        highestNote: candidateSpec.content.music.highestNote,
        positiveStyle: candidateSpec.content.music.positiveStyle,
        negativeStyle: candidateSpec.content.music.negativeStyle,
      },
      pointCount: candidateSpec.content.points.length,
    });
  })();

  const candidateDims: DimPoint[] = (() => {
    if (!candidateDetail) return [];
    const auto = [...candidateDetail.reviews].reverse().find((review) => review.reviewKind === "auto");
    const scores = (auto?.scores ?? {}) as { dims?: Array<{ label?: string; score?: number | null; weight?: number }> };
    if (!Array.isArray(scores.dims)) return [];
    return scores.dims
      .filter((dim) => typeof dim.score === "number")
      .map((dim) => ({ label: String(dim.label ?? "维度"), score: dim.score ?? null, weight: dim.weight }));
  })();

  const candidateThreshold = (() => {
    if (!candidateDetail) return 70;
    const auto = [...candidateDetail.reviews].reverse().find((review) => review.reviewKind === "auto");
    const scores = (auto?.scores ?? {}) as { minimumPassScore?: number };
    return typeof scores.minimumPassScore === "number" ? scores.minimumPassScore : 70;
  })();

  // 这首歌历次候选的总分，按时间正序画趋势
  const scoreTrend = (openRecord?.candidates ?? [])
    .filter((candidate) => typeof candidate.autoTotal === "number")
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((candidate, index) => ({
      label: `第 ${index + 1} 次`,
      total: candidate.autoTotal,
      passed: candidate.autoPassed,
    }));

  const candidateTimeline = (() => {
    if (!candidateDetail) return undefined;
    const auto = [...candidateDetail.reviews].reverse().find((review) => review.reviewKind === "auto");
    const scores = (auto?.scores ?? {}) as { lyricsTimeline?: LyricLineTiming[] };
    return Array.isArray(scores.lyricsTimeline) && scores.lyricsTimeline.length ? scores.lyricsTimeline : undefined;
  })();

  return (
    <Grid gap="base">
      <Banner
        variant={minimax.ready ? "default" : "alert"}
        title={`${MINIMAX_MUSIC_MODEL_LABELS[minimax.batchModel]} · RPM ${minimax.requestsPerMinute} · 单次成本 0.0`}
        description={minimax.ready
          ? "生产批次由服务端使用后台配置的模型生成；浏览器不能覆盖模型或速率。"
          : "MiniMax API Key 尚未配置，仍可管理规格和评审历史，但不能生成候选。"}
      />

      <ConsoleSection
        title="歌曲流水线"
        status={role === "admin"
          ? <Button size="sm" onClick={() => { setEditor(null); setCreationMode("theme"); setCreationOpen(true); }}>+ 创作</Button>
          : undefined}
      >
        <Grid gap="sm">
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Input label="搜索" placeholder="按标题、规格 key 或场景搜索" value={search}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSearch(event.target.value); setPage(1); }} />
            </GridItem>
            <GridItem>
              <Select label="阶段" value={stageFilter} items={[...STAGE_ITEMS]}
                onValueChange={(value: StageKey | "all" | null) => { if (value) { setStageFilter(value); setPage(1); } }}
                renderValue={(value: StageKey | "all") => value === "all" ? "全部" : STAGE_LABEL[value]} />
            </GridItem>
          </Grid>
          <Table>
            <thead><tr><th>歌曲</th><th>阶段</th><th>修订</th><th>候选</th><th>最近更新</th><th>操作</th></tr></thead>
            <tbody>
              {/* 创作任务还没产出规格时，先在这里占一行，别让人以为提交丢了 */}
              {pendingRuns.map((run) => (
                <tr key={run.runId}>
                  <td><Text bold>{run.title}</Text><Text variant="secondary">创作任务进行中</Text></td>
                  <td><StageBadge stage={run.stage} /></td>
                  <td>—</td>
                  <td>0</td>
                  <td>{formatDate(run.updatedAt)}</td>
                  <td><LinkButton size="sm" variant="ghost" href="/console/jobs">去任务队列</LinkButton></td>
                </tr>
              ))}
              {pageSlice(filtered, page, pageSize).map((record) => (
                <tr key={record.specKey}>
                  <td><Text bold>{record.title}</Text><Text variant="secondary">{record.specKey}</Text></td>
                  <td><StageBadge stage={record.stage} /></td>
                  <td>v{record.latest.revision}</td>
                  <td>{record.candidates.length}</td>
                  <td>{formatDate(record.updatedAt)}</td>
                  <td>{record.runId && (record.stage === "await_knowledge" || record.stage === "await_generation")
                    ? <LinkButton size="sm" variant="secondary" href="/console/jobs">去确认</LinkButton>
                    : <Button size="sm" variant="ghost" onClick={() => {
                    setOpenKey(record.specKey);
                    setDetailStage(record.stage === "draft" || record.stage === "spec_review" || record.stage === "retired"
                      ? "spec"
                      : record.stage === "ready" || record.stage === "failed" ? "generation" : "review");
                  }}>详情</Button>}</td>
                </tr>
              ))}
              {!filtered.length && !pendingRuns.length && (
                <tr><td colSpan={6}><Text variant="secondary">没有匹配的歌曲。点右上角「+ 创作」从一个主题开始。</Text></td></tr>
              )}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={filtered.length}
            onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer
        open={creationOpen}
        onOpenChange={(open) => { setCreationOpen(open); if (!open) setEditor(null); }}
        title={editor?.source ? "创建新修订" : "创作"}
        description="提交后立即关闭；主题拆解、规格流转、候选生成和评分都在任务队列运行。"
      >
        <Grid gap="base">
          <Tabs variant="underline" value={creationMode} onValueChange={(value) => setCreationMode(value as CreationMode)} tabs={[
            { value: "theme", label: "主题出歌" },
            { value: "spec", label: editor?.source ? "新修订" : "手动 SongSpec" },
          ]} />
          {creationMode === "theme" && (
            <ThemeSongWizard
              ai={ai}
              minimaxReady={minimax.ready}
              defaultModel={minimax.batchModel}
              onSubmitted={(manualConfirmation) => finishCreation(
                "创作任务已提交",
                manualConfirmation
                  ? "任务会在知识确认和候选生成前等待你操作；请到任务队列查看详情。"
                  : "确认知识内容后，系统会自动生成候选并评分；请到任务队列查看详情。",
              )}
            />
          )}
          {creationMode === "spec" && (
            <SongSpecEditor
              source={editor?.source}
              onSaved={(songSpec) => finishCreation(`SongSpec ${songSpec.specKey} v${songSpec.revision} 已创建`)}
              onCancel={() => { setEditor(null); setCreationOpen(false); }}
            />
          )}
        </Grid>
      </ConsoleDrawer>

      <ConsoleDrawer
        open={Boolean(openRecord)}
        onOpenChange={(open) => { if (!open) setOpenKey(null); }}
        title={openRecord ? openRecord.title : ""}
        description={openRecord ? `${openRecord.specKey} · v${openRecord.latest.revision} · ${STAGE_LABEL[openRecord.stage]}` : ""}
      >
        {openRecord && (
          <Grid gap="base">
            <Tabs variant="underline" value={detailStage} onValueChange={(value) => setDetailStage(value as RecordDetailStage)} tabs={[
              { value: "spec", label: "规格与内容" },
              { value: "generation", label: "候选生成" },
              { value: "review", label: "评审与母带" },
            ]} />

            {detailStage === "spec" && (
              <>
                <ConsoleSection title="规格与知识" status={<StatusBadge status={openRecord.latest.status} />}>
                  <Grid gap="sm">
                    <Grid variant="2up" gap="sm">
                      <GridItem><Text variant="secondary">学习目标</Text><Text>{openRecord.latest.content.learning.objective}</Text></GridItem>
                      <GridItem><Text variant="secondary">目标人群</Text><Text>{openRecord.latest.content.audience}</Text></GridItem>
                      <GridItem><Text variant="secondary">时长 / BPM</Text><Text>{openRecord.latest.content.music.durationSec} 秒 / {openRecord.latest.content.music.bpm}</Text></GridItem>
                      <GridItem><Text variant="secondary">调性 / 音域</Text><Text>{openRecord.latest.content.music.key} · {openRecord.latest.content.music.lowestNote}–{openRecord.latest.content.music.highestNote}</Text></GridItem>
                    </Grid>
                    <Table>
                      <thead><tr><th>提示句</th><th>句尾答案</th><th>接唱提示</th></tr></thead>
                      <tbody>
                        {openRecord.latest.content.points.map((point) => (
                          <tr key={point.id}><td>{point.lead}</td><td><Text bold>{point.answer}</Text></td><td>{point.cue}</td></tr>
                        ))}
                      </tbody>
                    </Table>
                  </Grid>
                </ConsoleSection>
                <ConsoleSection title="规格操作">
                  <Grid variant="2up" gap="sm">
                    {openRecord.latest.status === "draft" && (
                      <GridItem><Button disabled={Boolean(busy)} onClick={() => transitionSpec(openRecord.latest, "submit")}>提交规格审核</Button></GridItem>
                    )}
                    {openRecord.latest.status === "spec_review" && (
                      <GridItem><Button disabled={Boolean(busy)} onClick={() => transitionSpec(openRecord.latest, "approve")}>批准规格</Button></GridItem>
                    )}
                    {openRecord.latest.status === "approved" && role === "admin" && (
                      <>
                        <GridItem><Button variant="secondary" disabled={Boolean(busy)} onClick={() => { setEditor({ source: openRecord.latest }); setCreationMode("spec"); setCreationOpen(true); setOpenKey(null); }}>创建新修订</Button></GridItem>
                        <GridItem><Button variant="secondary" disabled={Boolean(busy)} onClick={() => transitionSpec(openRecord.latest, "retire")}>退役规格</Button></GridItem>
                      </>
                    )}
                  </Grid>
                </ConsoleSection>
                <Text variant="mono-secondary">内容哈希：{openRecord.latest.contentHash}</Text>
              </>
            )}

            {detailStage === "generation" && (
              <ConsoleSection title="候选生成" status={<StageBadge stage={openRecord.stage} />}>
                <Grid gap="sm">
                  {openRecord.stage === "failed" && latestCandidate?.error && (
                    <Banner variant="alert" title="最近一次生成失败" description={latestCandidate.error} />
                  )}
                  <Text variant="secondary">生成任务使用后台模型与速率配置；音频先进入隔离候选区，再执行自动 ReportCard。</Text>
                  <Grid variant="2up" gap="sm">
                    {openRecord.latest.status === "approved" && role === "admin" && (
                      <GridItem>
                        <Button disabled={Boolean(busy) || !minimax.ready} onClick={() => generateCandidate(openRecord.latest, openRecord.stage === "failed" || openRecord.stage === "qc_failed")}>
                          {busy === `batch:${openRecord.latest.id}` ? "正在生成…" : openRecord.stage === "failed" || openRecord.stage === "qc_failed" ? "重新生成候选" : "生成候选"}
                        </Button>
                      </GridItem>
                    )}
                    {latestCandidate && (
                      <GridItem><Button variant="secondary" disabled={Boolean(busy)} onClick={() => openCandidate(latestCandidate.id)}>查看最新候选</Button></GridItem>
                    )}
                  </Grid>
                </Grid>
              </ConsoleSection>
            )}

            {detailStage === "review" && (
              <ConsoleSection title="评审与母带" status={<StageBadge stage={openRecord.stage} />}>
                <Grid gap="sm">
                  {openRecord.stage === "mastered" && <Banner variant="default" title="已批准唯一母带" description="母带详情与完整评审记录保留在候选详情中。" />}
                  {latestCandidate ? (
                    <>
                      <Text>最新候选：{modelLabel(latestCandidate.model)} · {STATUS_LABEL[latestCandidate.status] ?? latestCandidate.status}</Text>
                      <Button disabled={Boolean(busy)} onClick={() => openCandidate(latestCandidate.id)}>试听、评分与人工评审</Button>
                    </>
                  ) : (
                    <Text variant="secondary">还没有候选。请先切换到「候选生成」阶段。</Text>
                  )}
                </Grid>
              </ConsoleSection>
            )}

            <Button variant="secondary" onClick={() => {
              setHistoryStage(openRecord.candidates.length ? "candidates" : openRecord.batches.length ? "batches" : "revisions");
              setHistoryOpen(true);
            }}>查看完整历史</Button>
          </Grid>
        )}
      </ConsoleDrawer>

      <ConsoleDrawer
        open={historyOpen && Boolean(openRecord)}
        onOpenChange={(open) => setHistoryOpen(open)}
        title={openRecord ? `${openRecord.title} · 历史记录` : ""}
        description="规格修订、每次生成批次和每个候选的完整留痕。"
      >
        {openRecord && (
          <Grid gap="base">
            <ConsoleSection title={`规格修订（${openRecord.revisions.length}）`}>
              <Table>
                <thead><tr><th>修订</th><th>状态</th><th>创建时间</th><th>内容哈希</th></tr></thead>
                <tbody>
                  {openRecord.revisions.map((revision) => (
                    <tr key={revision.id}>
                      <td>v{revision.revision}{revision.id === openRecord.latest.id ? "（当前）" : ""}</td>
                      <td><StatusBadge status={revision.status} /></td>
                      <td>{formatDate(revision.createdAt)}</td>
                      <td><Text variant="mono-secondary">{revision.contentHash.slice(7, 27)}…</Text></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </ConsoleSection>

            <ConsoleSection title={`生成批次（${openRecord.batches.length}）`}>
              <Table>
                <thead><tr><th>批次时间</th><th>状态</th><th>候选数</th><th>批次 ID</th></tr></thead>
                <tbody>
                  {openRecord.batches.map((batch) => (
                    <tr key={batch.id}>
                      <td>{formatDate(batch.createdAt)}</td>
                      <td><StatusBadge status={batch.status} /></td>
                      <td>{batch.candidates.length}</td>
                      <td><Text variant="mono-secondary">{batch.id.slice(0, 8)}</Text></td>
                    </tr>
                  ))}
                  {!openRecord.batches.length && <tr><td colSpan={4}><Text variant="secondary">还没有生成过。</Text></td></tr>}
                </tbody>
              </Table>
            </ConsoleSection>

            <ConsoleSection title={`候选（${openRecord.candidates.length}）`}>
              <Table>
                <thead><tr><th>模型</th><th>状态</th><th>耗时</th><th>成本</th><th>时间</th><th>失败原因</th><th>操作</th></tr></thead>
                <tbody>
                  {openRecord.candidates.map((candidate) => (
                    <tr key={candidate.id}>
                      <td>{modelLabel(candidate.model)}</td>
                      <td><StatusBadge status={candidate.status} /></td>
                      <td>{formatLatency(candidate.latencyMs)}</td>
                      <td>{formatCost(candidate.costMicros)}</td>
                      <td>{formatDate(candidate.createdAt)}</td>
                      <td>{candidate.error || "—"}</td>
                      <td><Button size="sm" variant="ghost" onClick={() => { setHistoryOpen(false); openCandidate(candidate.id); }}>试听与评审</Button></td>
                    </tr>
                  ))}
                  {!openRecord.candidates.length && <tr><td colSpan={7}><Text variant="secondary">还没有候选。</Text></td></tr>}
                </tbody>
              </Table>
            </ConsoleSection>

            {(openRecord.stage === "failed" || openRecord.stage === "qc_failed") && role === "admin" && (
              <Button disabled={Boolean(busy) || !minimax.ready} onClick={() => generateCandidate(openRecord.latest, true)}>
                {busy === `batch:${openRecord.latest.id}` ? "正在重新生成…" : "重新生成候选"}
              </Button>
            )}
          </Grid>
        )}
      </ConsoleDrawer>

      <ConsoleDrawer
        open={candidateOpen}
        onOpenChange={(open) => { setCandidateOpen(open); if (!open) setCandidateDetail(null); }}
        title={candidateDetail ? `候选 · ${modelLabel(candidateDetail.model)}` : ""}
        description={candidateDetail
          ? `${STATUS_LABEL[candidateDetail.status] ?? candidateDetail.status} · ${formatLatency(candidateDetail.latencyMs)} · ${formatDate(candidateDetail.createdAt)}`
          : ""}
      >
        {candidateDetail && (
          <Grid gap="base">
            {candidateDetail.master && <Banner variant="default" title="已批准为唯一母带" description={`母带哈希：${candidateDetail.master.masterHash}`} />}
            {candidateDetail.error && (
              <Banner
                variant="alert"
                // 有音频说明模型出歌了，是自动质检把它判下来的，别写成生成失败
                title={candidateDetail.audioUrl ? "自动质检未通过，已淘汰（音频仍可试听）" : "生成失败"}
                description={candidateDetail.error}
              />
            )}

            <ConsoleSection title="试听与歌词">
              <Grid gap="sm">
                <CandidatePlayer
                  audioUrl={candidateDetail.audioUrl}
                  lyrics={candidateLyrics}
                  prompt={candidatePrompt}
                  briefZh={candidateSpec?.content.music.brief?.zh}
                  timeline={candidateTimeline}
                  lrcUrl={candidateDetail.audioUrl ? `/api/admin/candidates/${candidateDetail.id}/lyrics` : undefined}
                />
                <Grid variant="4up" gap="sm">
                  <GridItem><Text variant="secondary">模型</Text><Text>{modelLabel(candidateDetail.model)}</Text></GridItem>
                  <GridItem><Text variant="secondary">生成耗时</Text><Text>{formatLatency(candidateDetail.latencyMs)}</Text></GridItem>
                  <GridItem><Text variant="secondary">成本</Text><Text>{formatCost(candidateDetail.costMicros)}</Text></GridItem>
                  <GridItem><Text variant="secondary">生成时间</Text><Text>{formatDate(candidateDetail.createdAt)}</Text></GridItem>
                </Grid>
                {formatAudioMetadata(candidateDetail.metadata) && (
                  <Text variant="secondary">音频规格：{formatAudioMetadata(candidateDetail.metadata)}</Text>
                )}
                {!candidateDetail.audioUrl && role === "admin" && openRecord && (
                  <Button disabled={Boolean(busy) || !minimax.ready} onClick={() => { setCandidateOpen(false); generateCandidate(openRecord.latest, true); }}>
                    重新生成候选
                  </Button>
                )}
              </Grid>
            </ConsoleSection>

            {candidateDoctor && candidateDoctor.fixes.length > 0 && (
              <ConsoleSection
                title="下一轮优化建议"
                status={<Badge variant="info">{candidateDoctor.fixes.length} 条</Badge>}
              >
                <Grid gap="sm">
                  <Table>
                    <thead><tr><th>维度</th><th>中文（给运营看）</th><th>英文（发给模型）</th></tr></thead>
                    <tbody>
                      {candidateDoctor.fixes.map((fix) => (
                        <tr key={fix.dim}>
                          <td><Text bold>{fix.dim}</Text></td>
                          <td>{fix.zh}</td>
                          <td><Text variant="mono-secondary">{fix.en}</Text></td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Text variant="secondary" size="xs">
                    下一轮参数：BPM {candidateDoctor.music.bpm} · 音域 {candidateDoctor.music.lowestNote}–{candidateDoctor.music.highestNote}
                  </Text>
                  {role === "admin" && (
                    <Grid variant="2up" gap="sm">
                      <GridItem>
                        <Button disabled={Boolean(busy) || !minimax.ready} onClick={() => improveCandidate(1)}>
                          {busy.startsWith("improve:") ? "正在重跑…" : "按建议改一轮并重生成"}
                        </Button>
                      </GridItem>
                      <GridItem>
                        <Button variant="secondary" disabled={Boolean(busy) || !minimax.ready} onClick={() => improveCandidate(3)}>
                          自动重试到达标（最多 3 轮）
                        </Button>
                      </GridItem>
                    </Grid>
                  )}
                </Grid>
              </ConsoleSection>
            )}

            <ConsoleSection title="自动 ReportCard">
              <Grid gap="base">
                {candidateDims.length > 0 && <DimensionRadar dims={candidateDims} threshold={candidateThreshold} />}
                <AutoReportCard detail={candidateDetail} />
              </Grid>
            </ConsoleSection>

            <ConsoleSection title={`评审历史（${candidateDetail.reviews.length}）`}>
              <Table>
                <thead><tr><th>类型</th><th>结论</th><th>评审人</th><th>说明</th><th>时间</th></tr></thead>
                <tbody>
                  {candidateDetail.reviews.map((review) => (
                    <tr key={review.id}>
                      <td>{review.reviewKind === "auto" ? "自动质检" : review.reviewKind === "content" ? "内容评审" : "音乐评审"}</td>
                      <td><Badge variant={review.verdict === "pass" ? "success" : "warning"}>{REVIEW_VERDICT_ITEMS.find((item) => item.value === review.verdict)?.label ?? review.verdict}</Badge></td>
                      <td>{review.reviewerName ?? (review.reviewerId ? review.reviewerId.slice(0, 8) : "系统")}</td>
                      <td>{review.notes || "—"}</td>
                      <td>{formatDate(review.createdAt)}</td>
                    </tr>
                  ))}
                  {!candidateDetail.reviews.length && <tr><td colSpan={5}><Text variant="secondary">还没有评审记录。</Text></td></tr>}
                </tbody>
              </Table>
            </ConsoleSection>

            {!candidateDetail.master && candidateDetail.status === "generated" && (
              <ConsoleSection title="人工评审">
                <Grid gap="sm">
                  <Grid variant="2up" gap="sm">
                    <GridItem><Select label="评审类型" value={reviewKind} items={[...REVIEW_KIND_ITEMS]}
                      onValueChange={(value: ReviewKind | null) => value && setReviewKind(value)}
                      renderValue={(value: ReviewKind) => REVIEW_KIND_ITEMS.find((item) => item.value === value)?.label ?? value} /></GridItem>
                    <GridItem><Select label="评审结论" value={reviewVerdict} items={[...REVIEW_VERDICT_ITEMS]}
                      onValueChange={(value: ReviewVerdict | null) => value && setReviewVerdict(value)}
                      renderValue={(value: ReviewVerdict) => REVIEW_VERDICT_ITEMS.find((item) => item.value === value)?.label ?? value} /></GridItem>
                  </Grid>
                  <InputArea label="评审说明" description="不通过、需要重绘或直接淘汰时必须说明原因。" value={reviewNotes} onValueChange={setReviewNotes} autoResize minRows={3} maxRows={8} />
                  <Grid variant="2up" gap="sm">
                    <GridItem><Button disabled={Boolean(busy)} onClick={() => actOnCandidate({ action: "review", reviewKind, verdict: reviewVerdict, notes: reviewNotes, scores: {} }, "人工评审已记录")}>提交评审</Button></GridItem>
                    <GridItem><Button variant="secondary" disabled={Boolean(busy) || !reviewNotes.trim()} onClick={() => actOnCandidate({ action: "needs_inpaint", notes: reviewNotes }, "候选已标记为需要重绘")}>需要重绘</Button></GridItem>
                    <GridItem><Button variant="secondary" disabled={Boolean(busy) || !reviewNotes.trim()} onClick={() => actOnCandidate({ action: "reject", notes: reviewNotes }, "候选已淘汰")}>淘汰候选</Button></GridItem>
                    {role === "admin" && <GridItem><Button disabled={Boolean(busy) || !canApproveMaster(candidateDetail)} onClick={() => actOnCandidate({ action: "approve_master" }, "候选已批准为唯一母带")}>批准母带</Button></GridItem>}
                  </Grid>
                  {role === "admin" && !canApproveMaster(candidateDetail) && (
                    <Text variant="secondary">批准母带前，自动、内容、音乐评审必须全部通过，且内容与音乐评审人必须不同。</Text>
                  )}
                </Grid>
              </ConsoleSection>
            )}

            <Text variant="mono-secondary">候选 ID：{candidateDetail.id}</Text>
          </Grid>
        )}
      </ConsoleDrawer>
    </Grid>
  );
}
