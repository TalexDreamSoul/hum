import { redirect } from "next/navigation";
import { ConsolePage } from "@/components/console/console-ui";
import { JobsWorkspace } from "@/components/console/jobs-workspace";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const user = await requirePageUser();
  if (user.role !== "admin" && user.role !== "approver") redirect("/console");

  return (
    <ConsolePage
      title="任务队列"
      description="主题拆解、候选生成和模型测试都会在这里留痕：每一步进展、上游返回、耗时和失败原因都能点开看。"
    >
      <JobsWorkspace />
    </ConsolePage>
  );
}
