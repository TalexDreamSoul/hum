import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { actOnCandidate, candidateActionSchema, getCandidateDetail } from "@/lib/server/candidate-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    return NextResponse.json({ candidate: await getCandidateDetail(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    const input = candidateActionSchema.parse(await request.json());
    if (input.action === "approve_master" && user.role !== "admin") {
      return NextResponse.json({ error: "只有管理员可以批准母带" }, { status: 403 });
    }
    const candidate = await actOnCandidate(id, input, user.id);
    await recordAudit(user.id, `candidate.${input.action}`, "candidate", id, {
      reviewKind: input.action === "review" ? input.reviewKind : undefined,
      verdict: input.action === "review" ? input.verdict : undefined,
      status: candidate.status,
      masterId: candidate.master && typeof candidate.master === "object" && "id" in candidate.master ? candidate.master.id : undefined,
    });
    return NextResponse.json({ candidate });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
