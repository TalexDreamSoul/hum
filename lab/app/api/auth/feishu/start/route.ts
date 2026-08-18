import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api";
import { beginFeishuOAuth, resolvePublicOrigin } from "@/lib/server/feishu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const mode = request.nextUrl.searchParams.get("mode") === "link" ? "link" : "login";
    const destination = await beginFeishuOAuth(request, mode, request.nextUrl.searchParams.get("returnTo"));
    return NextResponse.redirect(destination);
  } catch (error) {
    const fallback = request.nextUrl.searchParams.get("mode") === "link" ? "/console/profile" : "/login";
    const response = apiErrorResponse(error);
    const payload = await response.json() as { error?: string };
    const destination = new URL(fallback, await resolvePublicOrigin(request));
    destination.searchParams.set("error", payload.error || "无法发起飞书授权");
    return NextResponse.redirect(destination);
  }
}
