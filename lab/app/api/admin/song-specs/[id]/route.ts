import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { getSongSpec, transitionSongSpec } from "@/lib/server/song-specs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const transitionInput = z.object({ action: z.enum(["submit", "approve", "retire"]) }).strict();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    return NextResponse.json({ songSpec: await getSongSpec(id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    const input = transitionInput.parse(await request.json());
    if ((input.action === "approve" || input.action === "retire") && user.role !== "admin") {
      return NextResponse.json({ error: "只有管理员可以批准或退役 SongSpec" }, { status: 403 });
    }
    const songSpec = await transitionSongSpec(id, input.action, user.id);
    await recordAudit(user.id, `song_spec.${input.action}`, "song_spec", id, {
      specKey: songSpec.specKey,
      revision: songSpec.revision,
      status: songSpec.status,
    });
    return NextResponse.json({ songSpec });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
