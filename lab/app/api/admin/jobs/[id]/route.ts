import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { buildJobPipeline } from "@/lib/server/job-pipeline";
import { getJob, listJobRuns } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) throw new ApiError(404, "任务不存在");
    return NextResponse.json({
      job,
      pipeline: await buildJobPipeline(job),
      history: await listJobRuns(job.rootJobId),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
