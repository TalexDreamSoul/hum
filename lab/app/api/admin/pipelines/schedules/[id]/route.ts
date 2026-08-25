import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { deletePipelineSchedule, pipelineScheduleUpdateSchema, updatePipelineSchedule } from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = paramsSchema.parse(await context.params);
    const input = pipelineScheduleUpdateSchema.parse(await request.json());
    return NextResponse.json({ schedule: await updatePipelineSchedule(id, input, user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = paramsSchema.parse(await context.params);
    await deletePipelineSchedule(id, user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
