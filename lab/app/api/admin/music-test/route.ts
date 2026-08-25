import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, ApiError, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { runTrackedJob, type JobTracker } from "@/lib/server/jobs";
import { createMusicTestPreview } from "@/lib/server/music-test-preview";
import { generateMiniMaxMusic, reserveMiniMaxRateLimit, type MiniMaxMusicRun } from "@/lib/server/minimax";
import { MOCK_MUSIC_MODEL } from "@/lib/server/mock-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const requestInput = z.object({
  model: z.literal(MOCK_MUSIC_MODEL),
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

interface MusicTestDelivery {
  model: MiniMaxMusicRun["model"];
  ok: boolean;
  latencyMs: number;
  audioUrl?: string;
  expiresAt?: number;
  durationMs?: number;
  sampleRate?: number;
  bitrate?: number;
  sizeBytes?: number;
  error?: string;
}

async function deliverPreview(run: MiniMaxMusicRun, job: JobTracker): Promise<MusicTestDelivery> {
  const summary = {
    model: run.model,
    ok: run.ok,
    latencyMs: run.latencyMs,
    durationMs: run.durationMs,
    sampleRate: run.sampleRate,
    bitrate: run.bitrate,
    sizeBytes: run.sizeBytes,
    error: run.error,
  };
  if (!run.ok) return summary;
  if (!run.audioBytes) throw new ApiError(502, "Mock provider 未返回试听音频");

  const preview = await createMusicTestPreview(run.audioBytes);
  job.artifact("试听", "audio", `${run.model} 临时试听`, {
    url: preview.audioUrl,
    label: `${run.model} · ${(run.latencyMs / 1000).toFixed(1)} 秒`,
    expiresAt: preview.expiresAt,
  });
  return {
    ...summary,
    audioUrl: preview.audioUrl,
    expiresAt: preview.expiresAt,
    sizeBytes: preview.sizeBytes,
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = requestInput.parse(await request.json());
    const models = [MOCK_MUSIC_MODEL] as const;
    await reserveMiniMaxRateLimit(user.id, models);

    // 全部失败时任务标记为失败，但仍要把每个模型的错误回给页面。
    const runs: MusicTestDelivery[] = [];
    let allFailed = false;
    try {
      await runTrackedJob({
        kind: "music_test",
        title: `模型测试：${models.join(" / ")}`,
        userId: user.id,
        input: { models, instrumental: input.instrumental, lyricsOptimizer: input.lyricsOptimizer },
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
            run.ok ? { durationMs: run.durationMs ?? null } : run.error,
          );
          return run;
        }));
        const deliveredRuns = await Promise.all(results.map((run) => deliverPreview(run, job)));
        job.setOutput(deliveredRuns.map((run) => ({
          model: run.model,
          ok: run.ok,
          latencyMs: run.latencyMs,
          durationMs: run.durationMs ?? null,
          sampleRate: run.sampleRate ?? null,
          bitrate: run.bitrate ?? null,
          sizeBytes: run.sizeBytes ?? null,
          error: run.error ?? null,
        })));
        runs.push(...deliveredRuns);
        if (!deliveredRuns.some((run) => run.ok)) throw new ApiError(502, "MiniMax 模型测试全部失败");
        return deliveredRuns;
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

    const expiresAt = runs.reduce<number | null>((earliest, run) => {
      if (run.expiresAt === undefined) return earliest;
      return earliest === null ? run.expiresAt : Math.min(earliest, run.expiresAt);
    }, null);
    const response = { runs, expiresAt, persisted: false };
    if (allFailed) {
      return NextResponse.json({ ...response, error: "MiniMax 模型测试全部失败" }, { status: 502 });
    }
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
