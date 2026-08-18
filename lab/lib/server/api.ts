import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getCurrentUser, type SessionUser, type UserRole } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireApiUser(roles?: UserRole[]): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "请先登录");
  if (roles && !roles.includes(user.role)) throw new ApiError(403, "没有执行此操作的权限");
  return user;
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}：` : "";
    return NextResponse.json({ error: `${where}${issue?.message || "请求参数无效"}` }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "请求失败";
  if (/UNIQUE constraint failed/i.test(message)) return NextResponse.json({ error: "记录已存在" }, { status: 409 });
  console.error("hum api error", error);
  return NextResponse.json({ error: message }, { status: 400 });
}
