import { NextResponse } from "next/server";
import { apiErrorResponse, ApiError, requireApiUser } from "@/lib/server/api";
import { getDb } from "@/lib/server/database";
import { createQiniuObjectUrl } from "@/lib/server/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = await context.params;
    const row = await getDb().prepare("SELECT object_key FROM songs WHERE id = ?").get(id) as { object_key: string } | undefined;
    if (!row) throw new ApiError(404, "歌曲不存在");
    return NextResponse.redirect(await createQiniuObjectUrl(row.object_key), 307);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
