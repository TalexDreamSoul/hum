import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const userInput = z.object({
  username: z.string().min(3).max(64),
  displayName: z.string().min(1).max(80),
  password: z.string().min(10).max(128),
  role: z.enum(["admin", "approver", "uploader"]),
});

export async function GET() {
  try {
    await requireApiUser(["admin"]);
    const users = await getDb().prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, u.role, u.status, u.created_at AS createdAt,
             CASE WHEN i.id IS NULL THEN 0 ELSE 1 END AS feishuLinked
      FROM users u LEFT JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'feishu'
      ORDER BY u.created_at ASC
    `).all();
    return NextResponse.json({ users });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireApiUser(["admin"]);
    const input = userInput.parse(await request.json());
    const user = await createUser(input, admin.id);
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
