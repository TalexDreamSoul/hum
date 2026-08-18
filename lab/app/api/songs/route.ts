import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, ApiError, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { getDb } from "@/lib/server/database";
import { runTrackedJob } from "@/lib/server/jobs";
import { analyzeUploadedSong } from "@/lib/server/song-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uploadedInput = z.object({
  key: z.string().min(1).max(600),
  hash: z.string().min(1).max(200),
  fsize: z.number().int().positive(),
  mimeType: z.string().max(160),
  scene: z.enum(["general", "morning", "bath", "commute", "meal", "play", "focus", "travel", "bedtime"]).default("general"),
});

export async function GET() {
  try {
    await requireApiUser();
    const songs = await getDb().prepare(`
      SELECT s.id, s.original_name AS originalName, s.mime_type AS mimeType,
             s.size_bytes AS sizeBytes, s.status, s.analysis_scene AS analysisScene, s.created_at AS createdAt,
             u.display_name AS uploadedBy
      FROM songs s JOIN users u ON u.id = s.uploaded_by
      ORDER BY s.created_at DESC LIMIT 200
    `).all();
    return NextResponse.json({ songs });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin", "uploader"]);
    const input = uploadedInput.parse(await request.json());
    const db = getDb();
    const grant = await db.prepare(`
      SELECT user_id, original_name, mime_type, size_bytes, expires_at
      FROM upload_grants WHERE object_key = ?
    `).get(input.key) as
      | { user_id: string; original_name: string; mime_type: string; size_bytes: number; expires_at: number }
      | undefined;
    if (!grant || grant.expires_at <= Date.now()) throw new ApiError(410, "上传授权已失效，请重新上传");
    if (grant.user_id !== user.id || grant.size_bytes !== input.fsize) throw new ApiError(403, "上传结果与授权不匹配");

    const songId = randomUUID();
    const now = Date.now();
    const mimeType = input.mimeType || grant.mime_type;
    await db.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO songs (id, object_key, original_name, mime_type, size_bytes, qiniu_hash, status, analysis_scene, uploaded_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)
      `).run(songId, input.key, grant.original_name, mimeType, input.fsize, input.hash, input.scene, user.id, now, now);
      await transaction.prepare("DELETE FROM upload_grants WHERE object_key = ?").run(input.key);
    })();
    await recordAudit(user.id, "song.upload", "song", songId, { objectKey: input.key, sizeBytes: input.fsize });
    if (mimeType.startsWith("audio/")) {
      after(async () => {
        try {
          await runTrackedJob(
            { kind: "song_analysis", title: `分析上传歌曲：${grant.original_name}`, userId: user.id, input: { songId, scene: input.scene } },
            async (job) => analyzeUploadedSong(songId, new AbortController().signal, job),
          );
        } catch {
          // 失败详情由任务队列持久化，上传登记本身仍然有效。
        }
      });
    }
    return NextResponse.json({ id: songId, status: "uploaded" }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
