import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { listEvaluationReports } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  try {
    await requireApiUser();
    const url = new URL(request.url);
    const verdict = url.searchParams.get("verdict");
    const page = optionalNumber(url.searchParams.get("page"));
    const pageSize = optionalNumber(url.searchParams.get("pageSize"));
    const result = await listEvaluationReports({
      page,
      pageSize,
      verdict: verdict === "pass" || verdict === "fail" || verdict === "warning" || verdict === "info" ? verdict : undefined,
      minScore: optionalNumber(url.searchParams.get("minScore")),
      maxScore: optionalNumber(url.searchParams.get("maxScore")),
      dimension: url.searchParams.get("dimension") || undefined,
      dimensionMax: optionalNumber(url.searchParams.get("dimensionMax")),
      domain: url.searchParams.get("domain") || undefined,
      ageBand: url.searchParams.get("ageBand") || undefined,
      scene: url.searchParams.get("scene") || undefined,
      model: url.searchParams.get("model") || undefined,
      search: url.searchParams.get("search") || undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
