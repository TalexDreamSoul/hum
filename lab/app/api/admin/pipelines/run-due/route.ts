import { after, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  executePipelinePlan,
  listRunnablePipelinePlanIds,
  runDuePipelineSchedules,
} from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const inputSchema = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = inputSchema.parse(await request.json().catch(() => ({})));
    const createdPlanIds = await runDuePipelineSchedules(user.id, input.limit);
    const runnableIds = await listRunnablePipelinePlanIds(input.limit);
    const planIds = [...new Set([...createdPlanIds, ...runnableIds])];
    after(async () => {
      await Promise.all(planIds.map((planId) => executePipelinePlan(planId).catch(() => undefined)));
    });
    return NextResponse.json({ planIds, created: createdPlanIds.length, mock: true, provider: "mock" });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
