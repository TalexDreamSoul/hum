import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getDb } from "@/lib/server/database";
import { addReportsToTestSet, removeReportFromTestSet } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ reportIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100) }).strict();

async function assertCanMutateTestSet(testSetId: string, user: { id: string; role: string }): Promise<void> {
  const owner = await getDb().prepare("SELECT created_by FROM test_sets WHERE id = ?").get(testSetId) as { created_by: string } | undefined;
  if (!owner) throw new ApiError(404, "测试集不存在");
  if (user.role !== "admin" && owner.created_by !== user.id) {
    throw new ApiError(403, "只能修改自己创建的测试集");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await assertCanMutateTestSet(id, user);
    const input = inputSchema.parse(await request.json());
    await addReportsToTestSet(id, input.reportIds, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await assertCanMutateTestSet(id, user);
    const reportId = new URL(request.url).searchParams.get("reportId");
    if (!reportId) return NextResponse.json({ error: "缺少 reportId" }, { status: 400 });
    await removeReportFromTestSet(id, reportId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
