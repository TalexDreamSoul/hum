import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { unlinkFeishuIdentity } from "@/lib/server/feishu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  try {
    const user = await requireApiUser();
    await unlinkFeishuIdentity(user);
    await recordAudit(user.id, "auth.feishu.unlink", "user", user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
