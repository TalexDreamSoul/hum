import { ConsolePage } from "@/components/console/console-ui";
import { GovernanceWorkspace } from "@/components/console/governance-workspace";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  const user = await requirePageUser();
  return (
    <ConsolePage
      title="内容治理"
      description="以权限、人工复审、量表、基准、发布门禁和审计证据约束英语、儿歌与数学内容的生产发布。"
    >
      <GovernanceWorkspace role={user.role as "admin" | "approver" | "uploader"} />
    </ConsolePage>
  );
}
