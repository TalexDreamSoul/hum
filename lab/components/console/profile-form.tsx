"use client";

import { useEffect, useState } from "react";
import { Badge, Banner, Button, Grid, Input, LinkButton, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

interface UserView { id: string; username: string; displayName: string; role: "admin" | "approver" | "uploader" }
interface FeishuView { provider: "feishu"; displayName: string; avatarUrl: string; linkedAt: number }

export function ProfileForm({
  user,
  feishu,
  feishuReady,
  initialSuccess,
  initialError,
}: {
  user: UserView;
  feishu: FeishuView | null;
  feishuReady: boolean;
  initialSuccess?: string;
  initialError?: string;
}) {
  const toast = useConsoleToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(feishu);

  // 飞书回调把结果放在 query 里带回来，进页面先弹一次。
  useEffect(() => {
    if (initialError) toast.error(initialError);
    else if (initialSuccess) toast.success(initialSuccess);
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName,
          currentPassword: newPassword ? currentPassword : undefined,
          newPassword: newPassword || undefined,
        }),
      });
      const payload = await response.json() as { error?: string; reauthenticate?: boolean };
      if (!response.ok) throw new Error(payload.error || "保存失败");
      if (payload.reauthenticate) {
        window.location.assign("/login");
        return;
      }
      toast.success("个人资料已更新");
    } catch (error) {
      toast.error("保存失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!window.confirm("解除飞书关联后，将不能再使用该飞书账号快捷登录。继续吗？")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/profile/feishu", { method: "DELETE" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "解除关联失败");
      setLinked(null);
      toast.success("飞书关联已解除");
    } catch (error) {
      toast.error("解除关联失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid gap="base">
      <ConsoleSection title="本地账号">
        <Grid gap="sm">
          <Text variant="secondary">账号：{user.username} · 角色：{user.role}</Text>
          <form onSubmit={save}>
            <Grid gap="sm">
              <Input label="显示名称" value={displayName}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value)} />
              <Input label="当前密码" type="password" autoComplete="current-password" value={currentPassword}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCurrentPassword(event.target.value)} />
              <Input label="新密码" type="password" autoComplete="new-password" placeholder="不修改则留空；至少 10 位" value={newPassword}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewPassword(event.target.value)} />
              <Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存资料"}</Button>
            </Grid>
          </form>
        </Grid>
      </ConsoleSection>
      <ConsoleSection
        title="第三方登录"
        status={<Badge variant={linked ? "success" : "neutral"}>{linked ? "已关联" : "未关联"}</Badge>}
      >
        <Grid gap="sm">
          <Text variant="secondary">第三方身份只能手动关联；不会按姓名或邮箱自动绑定。</Text>
          {linked ? (
            <>
              <Text bold>{linked.displayName}</Text>
              <Text variant="secondary">飞书 · {new Date(linked.linkedAt).toLocaleString("zh-CN")}</Text>
              <Button type="button" variant="secondary" onClick={unlink} disabled={busy}>解除关联</Button>
            </>
          ) : feishuReady ? (
            <LinkButton variant="secondary" href="/api/auth/feishu/start?mode=link&returnTo=/console/profile">
              关联飞书账号
            </LinkButton>
          ) : (
            <Banner variant="default" title="管理员尚未启用飞书登录" description="启用后，成员可在这里各自完成关联。" />
          )}
        </Grid>
      </ConsoleSection>
    </Grid>
  );
}
