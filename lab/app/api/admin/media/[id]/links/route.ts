import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { MEDIA_LINK_SUBJECT_TYPES, linkMediaAsset } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idInput = z.object({ id: z.string().trim().min(1).max(160) });

const linkInput = z.object({
  subjectType: z.enum(MEDIA_LINK_SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(160),
  purpose: z.string().min(1).max(80).default("primary"),
  position: z.number().int().min(0).max(100_000).default(0),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin", "uploader"]);
    const { id } = idInput.parse(await context.params);
    const input = linkInput.parse(await request.json());
    const asset = await linkMediaAsset({ assetId: id, ...input, userId: user.id });
    return NextResponse.json({ asset });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
