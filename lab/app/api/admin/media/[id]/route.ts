import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getMediaAsset } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idInput = z.object({ id: z.string().trim().min(1).max(160) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = idInput.parse(await context.params);
    return NextResponse.json({ asset: await getMediaAsset(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
