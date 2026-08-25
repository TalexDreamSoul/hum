import "server-only";

import type { JobKind, JobRecord, JobStageView } from "../jobs";
import { productionRunStateOf } from "../production-run";
import { getDb } from "./database";
import { getProviderSettings, isAiReady, isMiniMaxReady } from "./settings";

/**
 * 一次运行只覆盖整条链路的一段，但页面要看到整条链路。
 * 这里按任务类型声明完整阶段，再用产物、错误和上游可用性判断每段的状态和卡点。
 */
const PIPELINES: Record<JobKind, string[]> = {
  production_run: ["识别", "拆解", "歌词", "提示词", "知识确认", "批准规格", "生成", "评分", "人工评审"],
  theme_plan: ["识别", "拆解", "歌词", "提示词", "人工确认", "生成", "评分"],
  experiment_batch: ["规格", "歌词", "提示词", "生成", "评分", "人工评审"],
  music_test: ["请求", "结果"],
  provider_test: ["探测", "结论"],
  song_analysis: ["下载", "探测", "评分"],
};

/** 这一段不是本次任务负责的，交给谁、缺什么，都要说清楚。 */
const HANDOFF_NOTES: Record<string, string> = {
  人工确认: "等你在生产实验里核对知识点并勾选确认，才会进入生成。",
  知识确认: "等你在生产实验里核对知识点并确认，任务才会继续。",
  批准规格: "确认知识后任务只提交不可变 SongSpec，仍须管理员显式批准。",
  人工评审: "候选生成后需要内容与音乐两位评审分别通过，才能批准母带。",
};

async function lastFailedProviderNote(target: string) {
  const row = await getDb().prepare(`
    SELECT output_json FROM jobs
    WHERE kind = 'provider_test' AND input_json LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(`%"${target}"%`) as { output_json: string } | undefined;
  if (!row) return null;
  try {
    const output = JSON.parse(row.output_json) as { ok?: boolean; title?: string; detail?: string };
    if (!output || output.ok) return null;
    return [output.title, output.detail].filter(Boolean).join("：").slice(0, 200);
  } catch {
    return null;
  }
}

/** 生成阶段能不能往下走：MiniMax 没配或最近一次测试失败，都要点名。 */
async function musicBlocker(): Promise<string | null> {
  const settings = await getProviderSettings();
  if (!await isMiniMaxReady(settings)) return "MiniMax API Key 尚未配置，无法生成音频。";
  const failure = await lastFailedProviderNote("minimax");
  return failure ? `MiniMax 最近一次连通性测试未通过 — ${failure}` : null;
}

async function aiBlocker(): Promise<string | null> {
  return await isAiReady() ? null : "AI 端点尚未配置完整（Base URL、API Key、模型）。";
}

export async function buildJobPipeline(job: JobRecord): Promise<JobStageView[]> {
  const stages = PIPELINES[job.kind] ?? [];
  const reached = new Set(job.artifacts.map((artifact) => artifact.stage));
  const lastReached = job.artifacts.at(-1)?.stage ?? null;
  const lastIndex = lastReached ? stages.indexOf(lastReached) : -1;
  const musicBlockerNote = stages.some((stage) => stage === "生成" || stage === "评分") ? await musicBlocker() : null;
  const aiBlockerNote = job.kind === "theme_plan" ? await aiBlocker() : null;

  if (job.kind === "production_run") {
    const state = productionRunStateOf(job.output);
    const humanReviewComplete = state?.phase === "complete"
      && typeof state.humanReviewConfirmedBy === "string"
      && typeof state.humanReviewConfirmedAt === "number";
    const nextStage = stages.find((stage) => !reached.has(stage) && (stage !== "人工评审" || !humanReviewComplete)) ?? null;
    let activeStage: string | null = null;
    if (state?.phase === "waiting_plan") activeStage = "知识确认";
    else if (state?.phase === "waiting_approval" || state?.phase === "queued_approval" || state?.phase === "running_approval") activeStage = "批准规格";
    else if (state?.phase === "waiting_generation") activeStage = "生成";
    else if (state?.phase === "queued_generation" || state?.phase === "running_generation") {
      activeStage = reached.has("生成") ? "评分" : "生成";
    } else if (state?.phase === "waiting_human_review") activeStage = "人工评审";
    else if (state?.phase === "queued_plan" || state?.phase === "running_plan") activeStage = nextStage;
    const waiting = state?.phase === "waiting_plan"
      || state?.phase === "waiting_approval"
      || state?.phase === "waiting_generation"
      || state?.phase === "waiting_human_review";

    return stages.map((stage) => {
      if (stage === "人工评审") {
        if (humanReviewComplete) return { stage, status: "done" as const };
        if (state?.phase === "waiting_human_review") {
          return {
            stage,
            status: "waiting" as const,
            note: "候选已完成自动评分；必须由管理员显式记录人工复审检查点，且不会自动批准母带或发布。",
          };
        }
        return { stage, status: "pending" as const, note: HANDOFF_NOTES.人工评审 };
      }
      if (reached.has(stage)) return { stage, status: "done" as const };
      if (job.status === "failed" && stage === nextStage) return { stage, status: "failed" as const, note: job.error || "任务在这一步失败" };
      if (stage === activeStage) {
        if (waiting) {
          const note = state?.phase === "waiting_plan"
            ? "等待核对学习目标、知识点、句尾答案和歌词。"
            : state?.phase === "waiting_approval"
              ? "知识已确认，等待管理员显式批准 SongSpec。"
              : "等待确认后由 Mock provider 生成隔离候选。";
          return { stage, status: "waiting" as const, note };
        }
        return { stage, status: "running" as const };
      }
      if (stage === "生成" && musicBlockerNote) return { stage, status: "blocked" as const, note: musicBlockerNote };
      if (stage === "评分" && !reached.has("生成")) return { stage, status: "pending" as const, note: "候选音频落盘后自动执行 9 维 ReportCard。" };
      return { stage, status: "pending" as const };
    });
  }

  return stages.map((stage, index) => {
    if (reached.has(stage)) return { stage, status: "done" as const };
    const ownedByThisJob = index <= lastIndex + 1 && !HANDOFF_NOTES[stage];
    if (ownedByThisJob && job.status === "failed") return { stage, status: "failed" as const, note: job.error || "任务在这一步失败" };
    if (ownedByThisJob && job.status === "running") return { stage, status: "running" as const };
    if (HANDOFF_NOTES[stage]) return { stage, status: "pending" as const, note: HANDOFF_NOTES[stage] };
    if (stage === "生成") {
      if (musicBlockerNote) return { stage, status: "blocked" as const, note: musicBlockerNote };
      return { stage, status: "pending" as const, note: "确认后由生产实验创建实验批次。" };
    }
    if (stage === "评分") {
      if (musicBlockerNote) return { stage, status: "blocked" as const, note: "上一步没有音频，自动评分无法执行。" };
      return { stage, status: "pending" as const, note: "候选音频落盘后自动执行 9 维 ReportCard。" };
    }
    if ((stage === "拆解" || stage === "识别") && job.kind === "theme_plan") {
      if (aiBlockerNote) return { stage, status: "blocked" as const, note: aiBlockerNote };
    }
    return { stage, status: "pending" as const };
  });
}
