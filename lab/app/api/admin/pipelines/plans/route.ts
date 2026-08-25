import { after, NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  createPipelinePlan,
  executePipelinePlan,
  listPipelinePlans,
  pipelinePageQuerySchema,
  pipelinePlanCreateSchema,
} from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(["admin", "approver"]);
    const query = pipelinePageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await listPipelinePlans(query.page, query.pageSize));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = pipelinePlanCreateSchema.parse(await request.json());
    const plan = await createPipelinePlan(input, user.id);
    if (plan.status === "queued") {
      after(async () => {
        await executePipelinePlan(plan.id).catch(() => undefined);
      });
    }
    return NextResponse.json({ plan }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
