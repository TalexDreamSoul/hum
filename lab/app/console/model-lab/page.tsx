import { ConsolePage } from "@/components/console/console-ui";
import { MusicLab } from "@/components/console/music-lab";
import { requirePageAdmin } from "@/lib/server/auth";
import { getProviderSettings, isMiniMaxReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function ModelLabPage() {
  await requirePageAdmin();
  const settings = await getProviderSettings();
  return (
    <ConsolePage
      title="模型实验室"
      description="用同一份音乐描述和歌词对比 MiniMax Music 3.0 与 2.6；生成结果仅用于试听，不自动进入内容库。"
    >
      <MusicLab ready={await isMiniMaxReady(settings)} defaultModel={settings.minimax.defaultModel} />
    </ConsolePage>
  );
}
