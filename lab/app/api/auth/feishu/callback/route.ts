import { NextRequest, NextResponse } from "next/server";
import { createSession, getCurrentUser, recordAudit } from "@/lib/server/auth";
import { completeFeishuOAuth, resolvePublicOrigin } from "@/lib/server/feishu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const feishuError = request.nextUrl.searchParams.get("error");
  try {
    if (feishuError) throw new Error("飞书授权已取消");
    if (!state || !code) throw new Error("飞书回调参数不完整");
    const result = await completeFeishuOAuth(request, state, code);
    if (result.mode === "login") await createSession(result.userId, request);
    await recordAudit(result.userId, result.mode === "link" ? "auth.feishu.link" : "auth.feishu.login", "user", result.userId, {
      displayName: result.identity.displayName,
    });
    const destination = new URL(result.mode === "link" ? "/console/profile" : result.returnTo, await resolvePublicOrigin(request));
    destination.searchParams.set("success", result.mode === "link" ? "飞书账号已关联" : "飞书登录成功");
    return NextResponse.redirect(destination);
  } catch (error) {
    const destination = new URL(await getCurrentUser() ? "/console/profile" : "/login", await resolvePublicOrigin(request));
    destination.searchParams.set("error", error instanceof Error ? error.message : "飞书登录失败");
    return NextResponse.redirect(destination);
  }
}
