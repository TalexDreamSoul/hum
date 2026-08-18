import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { compareEvaluationReports } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiUser();
    const ids = new URL(request.url).searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
    return NextResponse.json({ reports: await compareEvaluationReports(ids) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
