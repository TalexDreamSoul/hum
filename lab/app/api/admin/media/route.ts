import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { MEDIA_KINDS, MEDIA_STATUSES, getMediaAsset, listMediaAssets, registerMockMediaAsset } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const queryInput = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  mediaKind: z.enum(MEDIA_KINDS).optional(),
  status: z.enum(MEDIA_STATUSES).optional(),
  search: z.string().max(120).optional(),
});

const mockInput = z.object({
  mode: z.literal("mock"),
  name: z.string().min(1).max(240),
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().min(0).max(500 * 1024 * 1024),
  mediaKind: z.enum(MEDIA_KINDS).optional(),
  contentHash: z.string().min(16).max(128).optional(),
});

export async function GET(request: Request) {
  try {
    await requireApiUser();
    const url = new URL(request.url);
    const input = queryInput.parse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      mediaKind: url.searchParams.get("mediaKind") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
    });
    return NextResponse.json(await listMediaAssets(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin", "uploader"]);
    const input = mockInput.parse(await request.json());
    const result = await registerMockMediaAsset(input, user.id);
    const asset = await getMediaAsset(result.assetId);
    return NextResponse.json({ asset, deduplicated: result.deduplicated }, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
