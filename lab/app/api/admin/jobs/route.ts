import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { JOB_KINDS, type JobKind } from "@/lib/jobs";
import { listJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(["admin", "approver"]);
    const page = Number.parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10);
    const pageSize = Number.parseInt(request.nextUrl.searchParams.get("pageSize") ?? "20", 10);
    const rawKind = request.nextUrl.searchParams.get("kind");
    const kind = JOB_KINDS.includes(rawKind as JobKind) ? rawKind as JobKind : undefined;
    return NextResponse.json(await listJobs(Number.isFinite(page) ? page : 1,
    Number.isFinite(pageSize) ? pageSize : 20,
    kind,));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
