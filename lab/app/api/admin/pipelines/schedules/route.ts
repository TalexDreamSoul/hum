import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  createPipelineSchedule,
  listPipelineSchedules,
  pipelinePageQuerySchema,
  pipelineScheduleCreateSchema,
} from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(["admin", "approver"]);
    const query = pipelinePageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await listPipelineSchedules(query.page, query.pageSize));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = pipelineScheduleCreateSchema.parse(await request.json());
    return NextResponse.json({ schedule: await createPipelineSchedule(input, user.id) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
