import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getMusicTestPreview } from "@/lib/server/music-test-preview";

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

export async function GET(request: Request, context: { params: Promise<{ handle: string }> }) {
  try {
    await requireApiUser(["admin"]);
    const { handle } = await context.params;
    const preview = await getMusicTestPreview(handle);
    const range = parseByteRange(request.headers.get("range"), preview.sizeBytes);
    if (range === null) {
      return new NextResponse(null, {
        status: 416,
        headers: { "content-range": `bytes */${preview.sizeBytes}`, "cache-control": "private, no-store, max-age=0" },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? preview.sizeBytes - 1;
    const stream = Readable.toWeb(createReadStream(preview.absolutePath, { start, end })) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, {
      status: range ? 206 : 200,
      headers: {
        "content-type": preview.contentType,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${preview.sizeBytes}` } : {}),
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
