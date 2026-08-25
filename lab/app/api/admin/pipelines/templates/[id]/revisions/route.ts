import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createPipelineTemplateRevision, pipelineRevisionCreateSchema } from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin"]);
    const { id } = paramsSchema.parse(await context.params);
    const input = pipelineRevisionCreateSchema.parse(await request.json());
    return NextResponse.json({ revision: await createPipelineTemplateRevision(id, input, user.id) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
