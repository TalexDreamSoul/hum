import { after, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createProductionRun, executeProductionRun } from "@/lib/server/production-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const job = await createProductionRun(await request.json(), user.id);
    after(async () => {
      try {
        await executeProductionRun(job.id);
      } catch {
        // executeProductionRun 已将失败原因写回任务；请求结束后不再重复抛出。
      }
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
