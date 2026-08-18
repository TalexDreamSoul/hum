import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { createExperimentBatch, listExperimentBatches } from "@/lib/server/experiments";
import { runTrackedJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET() {
  try {
    await requireApiUser(["admin", "approver"]);
    return NextResponse.json({ batches: await listExperimentBatches() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const body = await request.json();
    const batch = await runTrackedJob(
      { kind: "experiment_batch", title: "生成候选批次", userId: user.id, input: body },
      async (job) => {
        const created = await createExperimentBatch(body, user.id, request.signal, job);
        if (!created) throw new Error("实验批次创建后未找到");
        job.setOutput({
          batchId: created.id,
          status: created.status,
          candidates: created.candidates.map((candidate) => ({
            id: candidate.id,
            model: candidate.model,
            status: candidate.status,
            latencyMs: candidate.latencyMs,
            error: candidate.error || undefined,
          })),
        });
        // 有音频就算生成成功——即使自动质检把它淘汰了；一个音频都没出来才是失败
        const produced = created.candidates.filter((candidate) => candidate.status === "generated" || candidate.status === "rejected");
        if (!produced.length) {
          const reason = created.candidates.find((candidate) => candidate.error)?.error;
          throw new Error(`候选全部生成失败${reason ? `：${reason}` : ""}`);
        }
        const rejected = produced.filter((candidate) => candidate.status === "rejected");
        if (rejected.length === produced.length) {
          job.step(`音频已生成，但自动质检未通过（${rejected.length} 个候选被淘汰）`, rejected[0]?.error);
        }
        return created;
      },
    );
    if (!batch) throw new Error("实验批次创建后未找到");
    await recordAudit(user.id, "experiment_batch.generate", "experiment_batch", batch.id, {
      specId: batch.specId,
      status: batch.status,
      candidateCount: batch.candidates.length,
      models: batch.candidates.map((candidate) => candidate.model),
    });
    return NextResponse.json({ batch }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
