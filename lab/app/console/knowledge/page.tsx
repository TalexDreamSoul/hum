import { ConsolePage } from "@/components/console/console-ui";
import { KnowledgeWorkspace } from "@/components/console/knowledge-workspace";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const user = await requirePageUser();
  return (
    <ConsolePage
      title="知识工作台"
      description="统一维护知识点、领域、教材与课程；每次修订、人工复审、发布和关系编排都保留在同一条治理链路中。"
    >
      <KnowledgeWorkspace role={user.role} />
    </ConsolePage>
  );
}
