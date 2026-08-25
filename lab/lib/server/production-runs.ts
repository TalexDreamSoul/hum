import "server-only";

import { z } from "zod";
import { productionRunStateOf, type ProductionRunState } from "../production-run";
import { MOCK_MUSIC_MODEL } from "./mock-provider";
import { ApiError } from "./api";
import { recordAudit } from "./auth";
import { createExperimentBatch } from "./experiments";
import {
  continueTrackedJob,
  createTrackedJob,
  getJob,
  setTrackedJobOutput,
  type JobRecord,
} from "./jobs";
import { createSongSpec, getSongSpec, transitionSongSpec } from "./song-specs";
import { createThemeSongPlan, themePlanInputSchema } from "./theme-planner";

const audioSettingSchema = z.object({
  sampleRate: z.union([z.literal(16000), z.literal(24000), z.literal(32000), z.literal(44100)]),
  bitrate: z.union([z.literal(32000), z.literal(64000), z.literal(128000), z.literal(256000)]),
  format: z.enum(["mp3", "wav", "pcm"]),
}).strict();

export const productionRunInputSchema = themePlanInputSchema.extend({
  models: z.array(z.literal(MOCK_MUSIC_MODEL)).max(1).optional(),
  promptInstruction: z.string().trim().max(800).default(""),
  lyricsInstruction: z.string().trim().max(800).default(""),
  lyricsMode: z.enum(["spec", "minimax-edit"]).default("spec"),
  audioSetting: audioSettingSchema.default({ sampleRate: 44100, bitrate: 256000, format: "mp3" }),
  manualConfirmation: z.boolean().default(false),
}).strict();

export type ProductionRunInput = z.infer<typeof productionRunInputSchema>;

function stateOf(job: JobRecord): ProductionRunState {
  const state = productionRunStateOf(job.output);
  if (!state) throw new ApiError(409, "创作任务状态无效");
  return state;
}

function actorOf(job: JobRecord): string {
  if (!job.actorUserId) throw new ApiError(409, "创作任务缺少发起人");
  return job.actorUserId;
}

async function auditSongSpec(userId: string, action: "create" | "submit" | "approve", specId: string): Promise<void> {
  const spec = await getSongSpec(specId);
  await recordAudit(userId, `song_spec.${action}`, "song_spec", spec.id, {
    specKey: spec.specKey,
    revision: spec.revision,
    status: spec.status,
    contentHash: spec.contentHash,
  });
}

export async function createProductionRun(input: unknown, userId: string): Promise<JobRecord> {
  const parsed = productionRunInputSchema.parse(input);
  const initialState: ProductionRunState = {
    phase: "queued_plan",
    manualConfirmation: parsed.manualConfirmation,
  };
  const job = await createTrackedJob({
    kind: "production_run",
    title: `主题创作：${parsed.theme}`,
    userId,
    input: parsed,
    output: initialState,
  });
  await recordAudit(userId, "production_run.create", "job", job.id, {
    theme: parsed.theme,
    ageBand: parsed.ageBand,
    scene: parsed.scene,
    manualConfirmation: parsed.manualConfirmation,
  });
  return job;
}

export async function advanceProductionRun(id: string, userId: string): Promise<JobRecord> {
  const job = await getJob(id);
  if (!job) throw new ApiError(404, "创作任务不存在");
  if (job.kind !== "production_run") throw new ApiError(409, "这不是创作流转任务");
  if (job.status !== "running") throw new ApiError(409, "任务已经结束，不能继续");
  const state = stateOf(job);

  let next: ProductionRunState;
  if (state.phase === "waiting_plan") {
    next = { ...state, phase: "queued_approval", knowledgeConfirmedBy: userId };
    await recordAudit(userId, "production_run.confirm_knowledge", "job", id, { specId: state.specId, mock: true, provider: "mock" });
  } else if (state.phase === "waiting_approval") {
    if (!state.specId) throw new ApiError(409, "创作任务缺少 SongSpec");
    const spec = await getSongSpec(state.specId);
    if (spec.status === "spec_review") {
      await transitionSongSpec(spec.id, "approve", userId);
      await auditSongSpec(userId, "approve", spec.id);
    }
    const approved = await getSongSpec(state.specId);
    if (approved.status !== "approved") throw new ApiError(409, "SongSpec 尚未进入 approved，不能生成候选");
    next = {
      ...state,
      phase: state.manualConfirmation ? "waiting_generation" : "queued_generation",
      approvalConfirmedBy: userId,
    };
    await recordAudit(userId, "production_run.approve_spec", "job", id, { specId: state.specId });
  } else if (state.phase === "waiting_generation") {
    next = { ...state, phase: "queued_generation", generationConfirmedBy: userId };
    await recordAudit(userId, "production_run.confirm_generation", "job", id, { specId: state.specId });
  } else if (state.phase === "waiting_human_review") {
    if (!state.batchId || !state.candidateIds?.length) throw new ApiError(409, "人工复审检查点缺少候选批次");
    const reviewedAt = Date.now();
    next = {
      ...state,
      phase: "complete",
      humanReviewConfirmedBy: userId,
      humanReviewConfirmedAt: reviewedAt,
    };
    await recordAudit(userId, "production_run.complete_human_review", "job", id, {
      batchId: state.batchId,
      candidateIds: state.candidateIds,
      reviewedAt,
      manualApproval: true,
      masterApproved: false,
      publish: false,
    });
  } else {
    throw new ApiError(409, "当前阶段不需要人工确认");
  }

  await setTrackedJobOutput(id, next);
  const updated = await getJob(id);
  if (!updated) throw new ApiError(404, "创作任务不存在");
  return updated;
}

export async function executeProductionRun(id: string): Promise<void> {
  await continueTrackedJob(id, async (tracker, job) => {
    const input = productionRunInputSchema.parse(job.input);
    let state = stateOf(job);

    while (true) {
      if (state.phase === "queued_plan") {
        state = { ...state, phase: "running_plan" };
        tracker.setOutput(state);
        tracker.step("开始由 Mock provider 拆解主题并生成歌词与音乐提示词", { mock: true, provider: "mock" });
        const plan = await createThemeSongPlan({
          theme: input.theme,
          ageBand: input.ageBand,
          scene: input.scene,
          tuning: input.tuning,
          lyricStyle: input.lyricStyle,
          sourceNotes: input.sourceNotes,
        }, new AbortController().signal, tracker);
        const spec = await createSongSpec(plan.songSpec, actorOf(job));
        await auditSongSpec(actorOf(job), "create", spec.id);
        tracker.artifact("拆解", "fields", "SongSpec 草稿", {
          fields: [
            { label: "规格", value: `${spec.specKey} v${spec.revision}` },
            { label: "状态", value: "等待知识确认" },
            { label: "内容哈希", value: spec.contentHash },
            { label: "Provider", value: "mock" },
          ],
          mock: true,
          provider: "mock",
        });
        tracker.step("SongSpec 草稿已创建，等待人工核对知识内容", { specId: spec.id });
        state = { ...state, phase: "waiting_plan", specId: spec.id };
        tracker.setOutput(state);
        return { value: undefined, complete: false };
      }

      if (state.phase === "queued_approval") {
        if (!state.specId) throw new ApiError(409, "创作任务缺少 SongSpec");
        const specId = state.specId;
        const confirmer = state.knowledgeConfirmedBy ?? actorOf(job);
        state = { ...state, phase: "running_approval" };
        tracker.setOutput(state);
        const draft = await getSongSpec(specId);
        if (draft.status === "draft") {
          await transitionSongSpec(draft.id, "submit", confirmer);
          await auditSongSpec(confirmer, "submit", draft.id);
        }
        const review = await getSongSpec(specId);
        if (review.status !== "spec_review") throw new ApiError(409, "SongSpec 未能进入 spec_review 状态");
        tracker.artifact("知识确认", "fields", "知识内容已提交审核", {
          fields: [
            { label: "确认范围", value: "学习目标、知识点、句尾答案和歌词" },
            { label: "下一步", value: "管理员显式批准 SongSpec" },
          ],
          mock: true,
          provider: "mock",
        });
        state = { ...state, phase: "waiting_approval" };
        tracker.setOutput(state);
        tracker.step("知识内容已确认并提交 spec_review；仍须管理员批准 SongSpec", { specId });
        return { value: undefined, complete: false };
      }

      if (state.phase === "queued_generation") {
        if (!state.specId) throw new ApiError(409, "创作任务缺少 SongSpec");
        const specId = state.specId;
        const generator = state.generationConfirmedBy ?? state.approvalConfirmedBy ?? actorOf(job);
        state = { ...state, phase: "running_generation" };
        tracker.setOutput(state);
        tracker.step("开始生成隔离 Mock WAV 候选并执行自动评分", { mock: true, provider: "mock" });
        const batch = await createExperimentBatch({
          specId,
          promptInstruction: input.promptInstruction,
          lyricsInstruction: input.lyricsInstruction,
          lyricsMode: input.lyricsMode,
          audioSetting: input.audioSetting,
        }, generator, new AbortController().signal, tracker);
        if (!batch) throw new Error("实验批次创建后未找到");
        const generated = batch.candidates.filter((candidate) => candidate.status === "generated");
        if (!generated.length) {
          const reason = batch.candidates.find((candidate) => candidate.error)?.error;
          throw new Error(`候选全部生成失败${reason ? `：${reason}` : ""}`);
        }
        await recordAudit(generator, "experiment_batch.generate", "experiment_batch", batch.id, {
          specId: batch.specId,
          status: batch.status,
          candidateCount: batch.candidates.length,
          models: batch.candidates.map((candidate) => candidate.model),
          productionRunId: id,
          mock: true,
          provider: "mock",
        });
        state = {
          ...state,
          phase: "waiting_human_review",
          batchId: batch.id,
          candidateIds: batch.candidates.map((candidate) => candidate.id),
        };
        tracker.setOutput(state);
        tracker.step("候选已生成并完成自动评分，停在待人工复审检查点；不会自动批准母带或发布");
        return { value: undefined, complete: false };
      }

      if (state.phase === "waiting_plan" || state.phase === "waiting_approval" || state.phase === "waiting_generation" || state.phase === "waiting_human_review") {
        return { value: undefined, complete: false };
      }
      if (state.phase === "complete") {
        if (!state.humanReviewConfirmedBy || !state.humanReviewConfirmedAt) {
          throw new ApiError(409, "创作任务不能在缺少人工复审检查点时完成");
        }
        return { value: undefined, complete: true };
      }
      throw new ApiError(409, `创作任务停在不可恢复阶段：${state.phase}`);
    }
  });
}
