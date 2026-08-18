import { ConsolePage } from "@/components/console/console-ui";
import { UsersWorkspace } from "@/components/console/users-workspace";
import { requirePageAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requirePageAdmin();
  return (
    <ConsolePage
      title="成员"
      description="管理员创建本地账号并分配角色；成员登录后自行在个人资料中关联飞书。"
    >
      <UsersWorkspace />
    </ConsolePage>
  );
}
