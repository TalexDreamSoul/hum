import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/server/api";
import { createFirstAdmin, createSession, isInitialized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setupInput = z.object({
  setupCode: z.string().min(1, "请输入初始化码"),
  username: z.string().min(3).max(64),
  displayName: z.string().max(80).optional(),
  password: z.string().min(10, "密码至少 10 位").max(128),
});

export async function POST(request: NextRequest) {
  try {
    if (await isInitialized()) return NextResponse.json({ error: "系统已经完成初始化" }, { status: 409 });
    const input = setupInput.parse(await request.json());
    const user = await createFirstAdmin(input);
    await createSession(user.id, request);
    return NextResponse.json({ user });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
