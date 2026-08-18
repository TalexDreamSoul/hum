import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { runTrackedJob } from "@/lib/server/jobs";
import { createThemeSongPlan } from "@/lib/server/theme-planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const body = await request.json();
    const theme = typeof body?.theme === "string" ? body.theme : "";
    const plan = await runTrackedJob(
      { kind: "theme_plan", title: `主题拆解：${theme || "未命名"}`, userId: user.id, input: body },
      async (job) => {
        const result = await createThemeSongPlan(body, request.signal, job);
        job.setOutput({
          title: result.songSpec.content.title,
          ageLabel: result.ageLabel,
          scene: result.scene,
          summary: result.summary,
          contentRisk: result.songSpec.content.learning.contentRisk,
          knowledgePoints: result.knowledgePoints,
        });
        return result;
      },
    );
    await recordAudit(user.id, "theme_song.plan", "song_spec_draft", plan.songSpec.specKey, {
      ageBand: plan.ageBand,
      scene: plan.scene,
      pointCount: plan.knowledgePoints.length,
      contentRisk: plan.songSpec.content.learning.contentRisk,
    });
    return NextResponse.json({ plan });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
