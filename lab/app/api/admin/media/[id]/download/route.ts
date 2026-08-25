import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getMediaAssetDownload } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idInput = z.object({ id: z.string().trim().min(1).max(160) });
const clipInput = z.object({
  startMs: z.coerce.number().int().nonnegative().optional(),
  endMs: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if ((value.startMs === undefined) !== (value.endMs === undefined)) {
    context.addIssue({ code: "custom", message: "切片下载必须同时提供开始与结束时间" });
  }
});

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = idInput.parse(await context.params);
    const query = clipInput.parse(Object.fromEntries(new URL(request.url).searchParams));
    const clip = query.startMs === undefined || query.endMs === undefined
      ? undefined
      : { startMs: query.startMs, endMs: query.endMs };
    const download = await getMediaAssetDownload(id, clip);
    return NextResponse.redirect(download.url, {
      status: 307,
      headers: {
        ...NO_STORE,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
