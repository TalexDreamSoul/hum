import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getPipelinePlan } from "@/lib/server/pipelines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = paramsSchema.parse(await context.params);
    return NextResponse.json({ plan: await getPipelinePlan(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
