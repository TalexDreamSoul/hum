import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { testNotificationChannel } from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ audioAssetId: z.string().trim().min(1).max(160).optional() }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin"]);
    const { id } = await context.params;
    const input = inputSchema.parse(await request.json().catch(() => ({})));
    await testNotificationChannel(id, input.audioAssetId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
