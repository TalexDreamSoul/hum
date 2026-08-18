import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { getCandidateDetail } from "@/lib/server/candidate-review";
import { createExperimentBatch } from "@/lib/server/experiments";
import { runTrackedJob } from "@/lib/server/jobs";
import { createSongSpec, getSongSpec, transitionSongSpec } from "@/lib/server/song-specs";
import { diagnose, type DoctorDim } from "@/lib/prompt-doctor";
import { buildSongSpecPrompt } from "@/lib/song-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAX_ROUNDS = 3;

/**
 * 按 ReportCard 的判词改提示词并重跑：每一轮都新建一个规格修订（旧版本不可变、留痕），
 * 生成后如果还没过门槛，就再按新判词改一轮，最多 3 轮。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { rounds?: number };
    const rounds = Math.min(Math.max(body.rounds ?? 1, 1), MAX_ROUNDS);

    const result = await runTrackedJob(
      { kind: "experiment_batch", title: "按 ReportCard 改提示词重生成", userId: user.id, input: { candidateId: id, rounds } },
      async (job) => {
        let sourceCandidateId = id;
        const history: Array<{ round: number; total: number | null; specId: string; passed: boolean }> = [];

        for (let round = 1; round <= rounds; round++) {
          const candidate = await getCandidateDetail(sourceCandidateId);
          const spec = await getSongSpec(candidate.specId);
          const auto = [...candidate.reviews].reverse().find((review) => review.reviewKind === "auto");
          const scores = (auto?.scores ?? {}) as {
            total?: number | null;
            minimumPassScore?: number;
            dims?: DoctorDim[];
          };
          if (!Array.isArray(scores.dims) || !scores.dims.length) {
            throw new ApiError(409, "这个候选没有自动评分，先生成一次再来改提示词");
          }

          const plan = diagnose({
            scene: spec.content.scene,
            total: scores.total ?? null,
            threshold: scores.minimumPassScore ?? 70,
            dims: scores.dims,
            music: {
              bpm: spec.content.music.bpm,
              lowestNote: spec.content.music.lowestNote,
              highestNote: spec.content.music.highestNote,
              positiveStyle: spec.content.music.positiveStyle,
              negativeStyle: spec.content.music.negativeStyle,
            },
            pointCount: spec.content.points.length,
          });

          if (plan.exhausted) {
            job.step(`第 ${round} 轮：没有可改的维度，停止`);
            break;
          }

          job.artifact(`第 ${round} 轮`, "fields", "ReportCard 判词转成的改法", {
            fields: plan.fixes.map((fix) => ({ label: fix.dim, value: fix.zh })),
          });

          const content = {
            ...spec.content,
            notes: `按第 ${round} 轮 ReportCard 自动改进：${plan.fixes.map((fix) => fix.dim).join("、")}`,
            music: {
              ...spec.content.music,
              bpm: plan.music.bpm,
              lowestNote: plan.music.lowestNote,
              highestNote: plan.music.highestNote,
              positiveStyle: plan.music.positiveStyle,
              negativeStyle: plan.music.negativeStyle,
            },
          };
          const revision = await createSongSpec({ specKey: spec.specKey, parentId: spec.id, content }, user.id);
          await transitionSongSpec(revision.id, "submit", user.id);
          await transitionSongSpec(revision.id, "approve", user.id);
          job.artifact(`第 ${round} 轮`, "text", "下一轮提示词（英文，直接发给模型）", { text: buildSongSpecPrompt(content) });
          job.step(`第 ${round} 轮：已建 v${revision.revision} 并批准，开始重新生成`);

          const batch = await createExperimentBatch({ specId: revision.id }, user.id, request.signal, job);
          const produced = batch?.candidates.find((item) => item.status === "generated" || item.status === "rejected");
          if (!produced) {
            job.step(`第 ${round} 轮：没有产出音频，停止`);
            break;
          }
          const detail = await getCandidateDetail(produced.id);
          const nextAuto = [...detail.reviews].reverse().find((review) => review.reviewKind === "auto");
          const nextScores = (nextAuto?.scores ?? {}) as { total?: number | null };
          const passed = produced.status === "generated";
          history.push({ round, total: nextScores.total ?? null, specId: revision.id, passed });
          job.step(`第 ${round} 轮：得分 ${nextScores.total ?? "—"}，${passed ? "通过门槛" : "仍未通过"}`);
          sourceCandidateId = produced.id;
          if (passed) break;
        }

        job.setOutput({ rounds: history, finalCandidateId: sourceCandidateId });
        return { candidateId: sourceCandidateId, history };
      },
    );

    await recordAudit(user.id, "candidate.improve", "candidate", id, { rounds: result.history.length });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
