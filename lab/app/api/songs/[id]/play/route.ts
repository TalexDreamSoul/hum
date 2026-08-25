import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getSongMediaPreview } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idInput = z.object({ id: z.string().uuid() });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = idInput.parse(await context.params);
    const preview = await getSongMediaPreview(id);
    if (preview.type === "metadata") {
      return NextResponse.json(preview, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }
    return NextResponse.redirect(preview.url, {
      status: 307,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
