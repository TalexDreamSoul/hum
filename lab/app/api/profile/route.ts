import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { updateProfile } from "@/lib/server/auth";
import { getLinkedFeishuIdentity } from "@/lib/server/feishu";
import { isFeishuReady } from "@/lib/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const profileInput = z.object({
  displayName: z.string().min(1).max(80).optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(10).max(128).optional(),
});

export async function GET() {
  try {
    const user = await requireApiUser();
    return NextResponse.json({ user, feishu: await getLinkedFeishuIdentity(user.id), feishuReady: await isFeishuReady() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireApiUser();
    const input = profileInput.parse(await request.json());
    await updateProfile(user.id, input);
    return NextResponse.json({ ok: true, reauthenticate: Boolean(input.newPassword) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
