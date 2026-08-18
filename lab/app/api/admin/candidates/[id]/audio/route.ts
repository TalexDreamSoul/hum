import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { apiErrorResponse, ApiError, requireApiUser } from "@/lib/server/api";
import { resolveCandidateArtifact } from "@/lib/server/candidates";
import { getDb } from "@/lib/server/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    const row = await getDb().prepare("SELECT artifact_path FROM candidates WHERE id = ?").get(id) as
      | { artifact_path: string | null }
      | undefined;
    if (!row) throw new ApiError(404, "候选不存在");
    if (!row.artifact_path) throw new ApiError(409, "候选尚无可播放音频");
    const artifact = resolveCandidateArtifact(row.artifact_path);
    const metadata = await stat(artifact);
    const range = parseByteRange(request.headers.get("range"), metadata.size);
    if (range === null) {
      return new NextResponse(null, {
        status: 416,
        headers: { "content-range": `bytes */${metadata.size}`, "cache-control": "private, no-store, max-age=0" },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? metadata.size - 1;
    const stream = Readable.toWeb(createReadStream(artifact, { start, end })) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, {
      status: range ? 206 : 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${metadata.size}` } : {}),
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
