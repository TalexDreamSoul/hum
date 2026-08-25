import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  deletePipelineTemplate,
  getPipelineTemplate,
  pipelineTemplateUpdateSchema,
  updatePipelineTemplate,
} from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = paramsSchema.parse(await context.params);
    return NextResponse.json({ template: await getPipelineTemplate(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = paramsSchema.parse(await context.params);
    const input = pipelineTemplateUpdateSchema.parse(await request.json());
    return NextResponse.json({ template: await updatePipelineTemplate(id, input, user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = paramsSchema.parse(await context.params);
    await deletePipelineTemplate(id, user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
