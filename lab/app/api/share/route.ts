import { NextResponse } from "next/server";
import { randomId, saveShare } from "@/lib/share-store";

export const runtime = "nodejs";

const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_REPORT = 2 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const fd = await req.formData();
    const report = fd.get("report");
    if (typeof report !== "string" || !report || report.length > MAX_REPORT) {
      return NextResponse.json({ error: "report 缺失或超过 2MB" }, { status: 400 });
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(report); }
    catch { return NextResponse.json({ error: "report 不是合法 JSON" }, { status: 400 }); }

    const audio = fd.get("audio");
    const id = randomId();
    let payload: { buf: Buffer; type: string } | null = null;
    if (audio && typeof audio !== "string") {
      if (audio.size > MAX_AUDIO) return NextResponse.json({ error: "音频超过 20MB 上限" }, { status: 413 });
      payload = { buf: Buffer.from(await audio.arrayBuffer()), type: audio.type || "audio/mpeg" };
    }
    parsed._share = { hasAudio: !!payload, at: new Date().toISOString() };
    await saveShare(id, parsed, payload);
    return NextResponse.json({ id, hasAudio: !!payload });
  } catch (e) {
    return NextResponse.json(
      { error: "上传失败：" + (e instanceof Error ? e.message : String(e)) },
      { status: 500 },
    );
  }
}
