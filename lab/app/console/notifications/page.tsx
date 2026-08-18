import { ConsolePage } from "@/components/console/console-ui";
import { NotificationsWorkspace } from "@/components/console/notifications-workspace";
import { requirePageAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePageAdmin();
  return (
    <ConsolePage
      title="飞书通知"
      description="配置应用机器人或群机器人，把待确认、失败、完成、高分和不合格报告推送到群；消息使用可靠 Outbox、幂等键和退避重试。"
    >
      <NotificationsWorkspace />
    </ConsolePage>
  );
}
