import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createQiniuUploadGrant } from "@/lib/server/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fileInput = z.object({
  name: z.string().min(1).max(240),
  size: z.number().int().positive().max(500 * 1024 * 1024),
  mimeType: z.string().max(160),
});

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin", "uploader"]);
    const file = fileInput.parse(await request.json());
    return NextResponse.json(await createQiniuUploadGrant(file, user.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
