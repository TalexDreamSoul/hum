import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { addReportsToTestSet, removeReportFromTestSet } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ reportIds: z.array(z.string().uuid()).min(1).max(100) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = inputSchema.parse(await request.json());
    await addReportsToTestSet(id, input.reportIds, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = await context.params;
    const reportId = new URL(request.url).searchParams.get("reportId");
    if (!reportId) return NextResponse.json({ error: "缺少 reportId" }, { status: 400 });
    await removeReportFromTestSet(id, reportId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
