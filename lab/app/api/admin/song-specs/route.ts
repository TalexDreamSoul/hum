import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { createSongSpec, listSongSpecs } from "@/lib/server/song-specs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireApiUser(["admin", "approver"]);
    return NextResponse.json({ songSpecs: await listSongSpecs() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const songSpec = await createSongSpec(await request.json(), user.id);
    await recordAudit(user.id, "song_spec.create", "song_spec", songSpec.id, {
      specKey: songSpec.specKey,
      revision: songSpec.revision,
      contentHash: songSpec.contentHash,
    });
    return NextResponse.json({ songSpec }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
