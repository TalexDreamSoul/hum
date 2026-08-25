import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getMediaAssetPreview } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };
const idInput = z.object({ id: z.string().trim().min(1).max(160) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = idInput.parse(await context.params);
    const preview = await getMediaAssetPreview(id);
    if (preview.type === "metadata") return NextResponse.json(preview, { headers: NO_STORE });
    return NextResponse.redirect(preview.url, { status: 307, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
