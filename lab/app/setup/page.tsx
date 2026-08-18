import { redirect } from "next/navigation";
import { AuthPage } from "@/components/console/auth-page";
import { SetupForm } from "@/components/console/setup-form";
import { ensureSetupCode, isInitialized } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isInitialized()) redirect("/login");
  await ensureSetupCode();
  return (
    <AuthPage
      title="初始化 hum 内容后台"
      description="首次启动只允许创建一个管理员。初始化码位于 HUM_DATA_DIR/setup-code.txt；提交成功后文件会立即删除。飞书和七牛都在进入后台后配置，不需要环境变量。"
    >
      <SetupForm />
    </AuthPage>
  );
}
