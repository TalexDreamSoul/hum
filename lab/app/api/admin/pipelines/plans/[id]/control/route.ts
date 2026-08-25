import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { controlPipelinePlan, executePipelinePlan, pipelinePlanControlSchema } from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const { id } = paramsSchema.parse(await context.params);
    const input = pipelinePlanControlSchema.parse(await request.json());
    if (input.action !== "approve_review" && user.role !== "admin") {
      throw new ApiError(403, "只有管理员可以控制计划执行");
    }
    const plan = await controlPipelinePlan(id, input, user.id);
    if (["queued", "cancelling"].includes(plan.status)) {
      after(async () => {
        await executePipelinePlan(plan.id).catch(() => undefined);
      });
    }
    return NextResponse.json({ plan });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
