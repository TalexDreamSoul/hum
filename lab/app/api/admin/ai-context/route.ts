import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createAiContextLink, revokeAiContextLink } from "@/lib/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  subjectType: z.enum(["report", "test_set"]),
  subjectId: z.string().trim().min(1).max(160),
  format: z.enum(["markdown", "json"]).default("markdown"),
}).strict();
const revokeSchema = z.object({ token: z.string().min(20).max(200) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const input = createSchema.parse(await request.json());
    const context = await createAiContextLink(input.subjectType, input.subjectId, user.id, input.format);
    return NextResponse.json({
      ...context,
      url: `/api/context/${context.token}`,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const input = revokeSchema.parse(await request.json());
    await revokeAiContextLink(input.token, user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
