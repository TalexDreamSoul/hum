import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/server/api";
import {
  authenticateLocal,
  checkLocalLoginRateLimit,
  createSession,
  isInitialized,
  LoginBlockedError,
  recordLocalLoginResult,
} from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export async function POST(request: NextRequest) {
  try {
    if (!await isInitialized()) return NextResponse.json({ error: "请先完成系统初始化" }, { status: 409 });
    const input = loginInput.parse(await request.json());
    const attemptKey = await checkLocalLoginRateLimit(request, input.username);
    const user = await authenticateLocal(input.username, input.password);
    await recordLocalLoginResult(attemptKey, Boolean(user));
    if (!user) return NextResponse.json({ error: "账号或密码不正确" }, { status: 401 });
    await createSession(user.id, request);
    return NextResponse.json({ user });
  } catch (error) {
    if (error instanceof LoginBlockedError) return NextResponse.json({ error: error.message }, { status: 429 });
    return apiErrorResponse(error);
  }
}
