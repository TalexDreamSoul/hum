import { redirect } from "next/navigation";
import { ConsolePage } from "@/components/console/console-ui";
import { ProductionWorkspace } from "@/components/console/production-workspace";
import { requirePageUser } from "@/lib/server/auth";
import { listExperimentBatches } from "@/lib/server/experiments";
import { getProviderSettings, isAiReady, isMiniMaxReady } from "@/lib/server/settings";
import { listSongSpecs } from "@/lib/server/song-specs";

export const dynamic = "force-dynamic";

export default async function ProductionPage() {
  const user = await requirePageUser();
  if (user.role !== "admin" && user.role !== "approver") redirect("/console");
  const settings = await getProviderSettings();

  return (
    <ConsolePage
      title="生产实验"
      description="输入主题与年龄段，确认知识拆解后自动生成候选并评分；正式母带仍需双人评审。候选不会自动写入正式歌曲库。"
    >
      <ProductionWorkspace
        role={user.role}
        initialSongSpecs={await listSongSpecs()}
        initialBatches={await listExperimentBatches()}
        ai={{
          ready: await isAiReady(settings),
          model: settings.ai.model,
        }}
        minimax={{
          ready: await isMiniMaxReady(settings),
          defaultModel: settings.minimax.defaultModel,
          enabledModels: settings.minimax.enabledModels,
          requestsPerMinute: settings.minimax.requestsPerMinute,
        }}
      />
    </ConsolePage>
  );
}
