import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getEvaluationReport } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = await context.params;
    return NextResponse.json({ report: await getEvaluationReport(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
