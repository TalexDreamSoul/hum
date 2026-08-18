import { ConsolePage } from "@/components/console/console-ui";
import { SkillsWorkspace } from "@/components/console/skills-workspace";
import { requirePageAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  await requirePageAdmin();
  return (
    <ConsolePage
      title="Skills"
      description="用不可变 SKILL.md revision 配置生成与评测知识；系统按领域、年龄和场景自动装配，并把实际版本写入提示词和报告快照。"
    >
      <SkillsWorkspace />
    </ConsolePage>
  );
}
