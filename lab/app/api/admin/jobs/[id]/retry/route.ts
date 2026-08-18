import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { createExperimentBatch } from "@/lib/server/experiments";
import { getJob, runTrackedJob } from "@/lib/server/jobs";
import { PROVIDER_TEST_TARGETS, testProvider, type ProviderTestTarget } from "@/lib/server/provider-tests";
import { createThemeSongPlan } from "@/lib/server/theme-planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * 重跑一次任务：沿用原输入，或用改过的输入重新提交。
 * 新任务挂在同一条链上（root_job_id），历史版本和产物都保留，不覆盖旧快照。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = await context.params;
    const source = await getJob(id);
    if (!source) throw new ApiError(404, "任务不存在");

    const body = await request.json().catch(() => ({})) as { input?: unknown };
    const input = body.input ?? source.input;
    const chain = { parentJobId: source.id, rootJobId: source.rootJobId };

    if (source.kind === "theme_plan") {
      const theme = typeof (input as { theme?: unknown })?.theme === "string" ? (input as { theme: string }).theme : "";
      const plan = await runTrackedJob(
        { kind: "theme_plan", title: `主题拆解：${theme || "未命名"}`, userId: user.id, input, ...chain },
        async (job) => {
          const result = await createThemeSongPlan(input, request.signal, job);
          job.setOutput({
            title: result.songSpec.content.title,
            ageLabel: result.ageLabel,
            scene: result.scene,
            summary: result.summary,
            contentRisk: result.songSpec.content.learning.contentRisk,
            knowledgePoints: result.knowledgePoints,
          });
          return result;
        },
      );
      await recordAudit(user.id, "theme_song.retry", "job", source.id, { theme });
      return NextResponse.json({ plan });
    }

    if (source.kind === "experiment_batch") {
      const batch = await runTrackedJob(
        { kind: "experiment_batch", title: "生成候选批次（重跑）", userId: user.id, input, ...chain },
        async (job) => {
          const created = await createExperimentBatch(input, user.id, request.signal, job);
          if (!created) throw new Error("实验批次创建后未找到");
          job.setOutput({ batchId: created.id, status: created.status });
          return created;
        },
      );
      await recordAudit(user.id, "experiment_batch.retry", "job", source.id, { batchId: batch?.id });
      return NextResponse.json({ batch });
    }

    if (source.kind === "provider_test") {
      const target = (input as { target?: string })?.target as ProviderTestTarget;
      if (!PROVIDER_TEST_TARGETS.includes(target)) throw new ApiError(400, "测试目标无效");
      const result = await runTrackedJob(
        { kind: "provider_test", title: source.title, userId: user.id, input: { target }, ...chain },
        async (job) => {
          const outcome = await testProvider(target, request.signal);
          job.step(outcome.title, outcome.detail);
          job.setOutput(outcome);
          return outcome;
        },
      );
      return NextResponse.json(result);
    }

    throw new ApiError(409, "模型测试请回到模型实验室重跑，那里才有完整的 prompt 和歌词。");
  } catch (error) {
    return apiErrorResponse(error);
  }
}
