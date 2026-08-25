import { after, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getDb } from "@/lib/server/database";
import { analyzeQiniuMediaAsset, registerUploadedSongMedia } from "@/lib/server/media";
import { runTrackedJob } from "@/lib/server/jobs";
import { analyzeUploadedSong } from "@/lib/server/song-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uploadedInput = z.object({
  key: z.string().min(1).max(600),
  hash: z.string().min(1).max(200),
  fsize: z.number().int().positive(),
  mimeType: z.string().max(160),
  contentHash: z.string().min(16).max(128).optional(),
  mediaKind: z.enum(["audio", "video", "screen_recording", "document", "image"]).optional(),
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
    const registration = await registerUploadedSongMedia(input, user.id);
    if (!registration.deduplicated && registration.mediaKind === "audio") {
      after(async () => {
        try {
          await runTrackedJob(
            { kind: "song_analysis", title: `分析上传歌曲：${input.key}`, userId: user.id, input: { songId: registration.songId, scene: input.scene, assetId: registration.assetId } },
            async (job) => analyzeUploadedSong(registration.songId, new AbortController().signal, job),
          );
        } catch {
          // 分析失败留在任务记录中；已登记媒体仍可重试。
        }
      });
    } else if (!registration.deduplicated && (registration.mediaKind === "video" || registration.mediaKind === "screen_recording")) {
      after(async () => {
        await analyzeQiniuMediaAsset(registration.assetId, new AbortController().signal).catch(() => undefined);
      });
    }
    return NextResponse.json({
      id: registration.songId,
      assetId: registration.assetId,
      mediaKind: registration.mediaKind,
      status: registration.status,
      deduplicated: registration.deduplicated,
    }, { status: registration.deduplicated ? 200 : 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
