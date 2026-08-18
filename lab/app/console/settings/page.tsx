import { ConsolePage } from "@/components/console/console-ui";
import { SettingsForm } from "@/components/console/settings-form";
import { requirePageAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePageAdmin();
  return (
    <ConsolePage
      title="外部服务配置"
      description="七牛、飞书和 AI 端点全部动态保存；密钥由本机 secret.key 加密，页面只显示是否已设置。"
    >
      <SettingsForm />
    </ConsolePage>
  );
}
