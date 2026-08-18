import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { setSkillStatus } from "@/lib/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin"]);
    const { id } = await context.params;
    const input = inputSchema.parse(await request.json());
    await setSkillStatus(id, input.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
