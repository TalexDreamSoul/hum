import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { MEDIA_REVIEW_KINDS, MEDIA_REVIEW_VERDICTS, reviewMediaAsset } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idInput = z.object({ id: z.string().trim().min(1).max(160) });

const reviewInput = z.object({
  reviewKind: z.enum(MEDIA_REVIEW_KINDS),
  verdict: z.enum(MEDIA_REVIEW_VERDICTS),
  score: z.number().int().min(0).max(100).nullable().optional(),
  dimensions: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(4_000).default(""),
  rubricRevisionId: z.string().trim().min(1).max(160).optional(),
  roundNo: z.number().int().min(1).max(100).default(1),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const { id } = idInput.parse(await context.params);
    const input = reviewInput.parse(await request.json());
    const asset = await reviewMediaAsset({ assetId: id, ...input, score: input.score ?? null, reviewerId: user.id });
    return NextResponse.json({ asset });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
