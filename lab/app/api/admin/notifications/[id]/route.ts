import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { deleteNotificationChannel, setNotificationChannelEnabled } from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ enabled: z.boolean() }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin"]);
    const { id } = await context.params;
    const input = inputSchema.parse(await request.json());
    await setNotificationChannelEnabled(id, input.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin"]);
    const { id } = await context.params;
    await deleteNotificationChannel(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
