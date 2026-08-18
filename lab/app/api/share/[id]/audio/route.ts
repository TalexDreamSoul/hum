import { createReadStream } from "fs";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { ID_RE, readShareAudioMeta, shareAudioPath } from "@/lib/share-store";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "id 无效" }, { status: 400 });
  const meta = await readShareAudioMeta(id);
  if (!meta) return new NextResponse("not found", { status: 404 });

  const range = req.headers.get("range");
  const common = {
    "content-type": meta.type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
  };

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), meta.size - 1) : meta.size - 1;
      if (start <= end && start < meta.size) {
        const stream = createReadStream(shareAudioPath(id), { start, end });
        return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            ...common,
            "content-range": `bytes ${start}-${end}/${meta.size}`,
            "content-length": String(end - start + 1),
          },
        });
      }
    }
  }
  const stream = createReadStream(shareAudioPath(id));
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...common, "content-length": String(meta.size) },
  });
}
