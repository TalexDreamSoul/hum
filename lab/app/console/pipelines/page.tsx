import { redirect } from "next/navigation";
import { PipelinesWorkspace } from "@/components/console/pipelines-workspace";
import { ConsolePage } from "@/components/console/console-ui";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
  const user = await requirePageUser();
  if (user.role !== "admin" && user.role !== "approver") redirect("/console");
  return (
    <ConsolePage
      title="自动流水线"
      description="管理版本化模板、可暂停计划和间隔计划任务。所有当前执行均为显式标记的 Mock provider，不会自动批准母带或发布。"
    >
      <PipelinesWorkspace role={user.role} />
    </ConsolePage>
  );
}
