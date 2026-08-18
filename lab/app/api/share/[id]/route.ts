import { NextResponse } from "next/server";
import { ID_RE, readShareReport } from "@/lib/share-store";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "id 无效" }, { status: 400 });
  const body = await readShareReport(id);
  if (!body) return NextResponse.json({ error: "分享不存在或已删除" }, { status: 404 });
  return new NextResponse(body, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}
