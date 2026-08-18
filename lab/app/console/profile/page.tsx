import { ConsolePage } from "@/components/console/console-ui";
import { ProfileForm } from "@/components/console/profile-form";
import { requirePageUser } from "@/lib/server/auth";
import { getLinkedFeishuIdentity } from "@/lib/server/feishu";
import { isFeishuReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ success?: string; error?: string }> }) {
  const user = await requirePageUser();
  const params = await searchParams;
  return (
    <ConsolePage
      title="个人资料"
      description="本地账号是身份根；飞书仅作为你主动绑定的快捷登录方式，不会按姓名或邮箱自动合并。"
    >
      <ProfileForm
        user={user}
        feishu={await getLinkedFeishuIdentity(user.id)}
        feishuReady={await isFeishuReady()}
        initialSuccess={params.success}
        initialError={params.error}
      />
    </ConsolePage>
  );
}
