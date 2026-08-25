import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  createPipelineTemplate,
  listPipelineTemplates,
  pipelinePageQuerySchema,
  pipelineTemplateCreateSchema,
} from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(["admin", "approver"]);
    const query = pipelinePageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await listPipelineTemplates(query.page, query.pageSize));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = pipelineTemplateCreateSchema.parse(await request.json());
    const template = await createPipelineTemplate(input, user.id);
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
