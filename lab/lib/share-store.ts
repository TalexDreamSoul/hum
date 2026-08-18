/** 分享包的文件系统存储。目录：$HUM_DATA_DIR/shares/<id>/ */

import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";

export const DATA_DIR =
  process.env.HUM_DATA_DIR || path.join(process.cwd(), "data");

const SHARES = path.join(DATA_DIR, "shares");
export const ID_RE = /^[a-z0-9]{10}$/;

export function randomId(): string {
  const cs = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += cs[b % 36];
  return s;
}

export function shareDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error("bad id");
  return path.join(SHARES, id);
}

export async function saveShare(
  id: string,
  report: Record<string, unknown>,
  audio: { buf: Buffer; type: string } | null,
): Promise<void> {
  const dir = shareDir(id);
  await mkdir(dir, { recursive: true });
  if (audio) {
    await writeFile(path.join(dir, "audio.bin"), audio.buf);
    await writeFile(path.join(dir, "audio.type"), audio.type, "utf-8");
  }
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report), "utf-8");
}

export async function readShareReport(id: string): Promise<string | null> {
  try {
    return await readFile(path.join(shareDir(id), "report.json"), "utf-8");
  } catch { return null; }
}

export async function readShareAudioMeta(id: string): Promise<{ size: number; type: string } | null> {
  try {
    const dir = shareDir(id);
    const st = await stat(path.join(dir, "audio.bin"));
    const type = (await readFile(path.join(dir, "audio.type"), "utf-8").catch(() => "audio/mpeg")).trim();
    return { size: st.size, type };
  } catch { return null; }
}

export function shareAudioPath(id: string): string {
  return path.join(shareDir(id), "audio.bin");
}
