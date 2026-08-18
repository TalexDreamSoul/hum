import { redirect } from "next/navigation";
import { AuthPage } from "@/components/console/auth-page";
import { LoginForm } from "@/components/console/login-form";
import { getCurrentUser, isInitialized } from "@/lib/server/auth";
import { isFeishuReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!await isInitialized()) redirect("/setup");
  if (await getCurrentUser()) redirect("/console");
  const params = await searchParams;
  return (
    <AuthPage
      title="登录 hum 内容后台"
      description="账号密码是主登录方式；飞书只用于已登录用户主动关联后的快捷登录。"
    >
      <LoginForm feishuReady={await isFeishuReady()} initialError={params.error} />
    </AuthPage>
  );
}
