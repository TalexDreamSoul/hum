import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, ApiError, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { runTrackedJob } from "@/lib/server/jobs";
import { generateMiniMaxMusic, reserveMiniMaxRateLimit } from "@/lib/server/minimax";
import { getMiniMaxComparisonModel, MINIMAX_CURRENT_MUSIC_MODELS } from "@/lib/minimax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const requestInput = z.object({
  model: z.enum(MINIMAX_CURRENT_MUSIC_MODELS),
  prompt: z.string().trim().min(1, "请填写音乐描述").max(2000, "音乐描述不能超过 2000 字"),
  lyrics: z.string().max(3500, "歌词不能超过 3500 字"),
  lyricsOptimizer: z.boolean(),
  instrumental: z.boolean(),
  compareWithPrevious: z.boolean(),
}).superRefine((value, context) => {
  if (!value.instrumental && !value.lyricsOptimizer && !value.lyrics.trim()) {
    context.addIssue({ code: "custom", path: ["lyrics"], message: "有人声且不自动生成歌词时，请填写歌词" });
  }
});


export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = requestInput.parse(await request.json());
    const models = input.compareWithPrevious
      ? [input.model, getMiniMaxComparisonModel(input.model)]
      : [input.model];
    await reserveMiniMaxRateLimit(user.id, models);

    // 全部失败时任务标记为失败，但仍要把每个模型的错误回给页面。
    const runs: Awaited<ReturnType<typeof generateMiniMaxMusic>>[] = [];
    let allFailed = false;
    try {
      await runTrackedJob({
        kind: "music_test",
        title: `模型测试：${models.join(" / ")}`,
        userId: user.id,
        input: { models, prompt: input.prompt, instrumental: input.instrumental, lyricsOptimizer: input.lyricsOptimizer },
      }, async (job) => {
        job.step(`并行请求 ${models.length} 个模型`, models);
        const results = await Promise.all(models.map(async (model) => {
          const run = await generateMiniMaxMusic({
            model,
            prompt: input.prompt,
            lyrics: input.lyrics,
            lyricsOptimizer: input.lyricsOptimizer,
            instrumental: input.instrumental,
            signal: request.signal,
          });
          job.step(
            `${model} ${run.ok ? "生成成功" : "生成失败"}，耗时 ${(run.latencyMs / 1000).toFixed(1)} 秒`,
            run.ok ? { durationMs: run.durationMs ?? null, traceId: run.traceId ?? null } : run.error,
          );
          return run;
        }));
        job.setOutput(results.map((run) => ({
          model: run.model,
          ok: run.ok,
          latencyMs: run.latencyMs,
          durationMs: run.durationMs ?? null,
          error: run.error,
        })));
        runs.push(...results);
        if (!results.some((run) => run.ok)) throw new ApiError(502, "MiniMax 模型测试全部失败");
        return results;
      });
    } catch (error) {
      if (!(error instanceof ApiError) || !runs.length) throw error;
      allFailed = true;
    }

    await recordAudit(user.id, "minimax.music_test", "provider", "minimax", {
      models,
      instrumental: input.instrumental,
      lyricsOptimizer: input.lyricsOptimizer,
      results: runs.map((run) => ({ model: run.model, ok: run.ok, latencyMs: run.latencyMs })),
    });

    const response = {
      runs,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      persisted: false,
    };
    if (allFailed) {
      return NextResponse.json({ ...response, error: "MiniMax 模型测试全部失败" }, { status: 502 });
    }
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
