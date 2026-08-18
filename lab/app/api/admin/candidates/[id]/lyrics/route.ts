import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { getCandidateDetail } from "@/lib/server/candidate-review";
import { getSongSpec } from "@/lib/server/song-specs";
import { buildLyricsTimeline, toLrc, type LyricLineTiming } from "@/lib/analysis/lyrics-timeline";
import { buildSongSpecLyrics } from "@/lib/song-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导出候选的 .lrc：优先用质检时反推的时间轴，没有就按字数估算。 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(["admin", "approver"]);
    const { id } = await context.params;
    const candidate = await getCandidateDetail(id);
    const spec = await getSongSpec(candidate.specId);
    const lyrics = buildSongSpecLyrics(spec.content);

    const auto = [...candidate.reviews].reverse().find((review) => review.reviewKind === "auto");
    const scores = (auto?.scores ?? {}) as { lyricsTimeline?: LyricLineTiming[] };
    const stored = Array.isArray(scores.lyricsTimeline) ? scores.lyricsTimeline : [];
    const timeline = stored.length
      ? stored
      : buildLyricsTimeline(lyrics, spec.content.music.durationSec, []);
    if (!timeline.length) throw new ApiError(409, "这个候选没有可导出的歌词");

    return new Response(toLrc(timeline, { title: spec.content.title, artist: "hum" }), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${spec.specKey}-v${spec.revision}.lrc"`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
