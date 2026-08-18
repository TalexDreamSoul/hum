import { ConsolePage } from "@/components/console/console-ui";
import { ReportsWorkspace } from "@/components/console/reports-workspace";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  await requirePageUser();
  return (
    <ConsolePage
      title="评分报告"
      description="自动入库全部声学报告，按合格、高分、单维弱项、领域、场景和模型筛选；可选中多份报告横向对比并保存为测试集。"
    >
      <ReportsWorkspace />
    </ConsolePage>
  );
}
