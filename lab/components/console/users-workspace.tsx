"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Grid, GridItem, Input, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

type Role = "admin" | "approver" | "uploader";
interface UserRow { id: string; username: string; displayName: string; role: Role; status: string; createdAt: number; feishuLinked: number }

const ROLE_ITEMS = [
  { value: "uploader", label: "上传" },
  { value: "approver", label: "审批" },
  { value: "admin", label: "管理员" },
] as const;
const ROLE_LABEL: Record<Role, string> = { admin: "管理员", approver: "审批", uploader: "上传" };

export function UsersWorkspace() {
  const toast = useConsoleToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "uploader" as Role });
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    const payload = await response.json() as { users?: UserRow[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "读取成员失败");
    setUsers(payload.users || []);
  }

  useEffect(() => { load().catch((error) => toast.error("读取成员失败", error.message)); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "创建成员失败");
      setForm({ username: "", displayName: "", password: "", role: "uploader" });
      await load();
      toast.success("成员已创建", "请将账号与临时密码安全交给本人");
    } catch (error) {
      toast.error("创建成员失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid gap="base">
      <ConsoleSection title="新增成员">
        <form onSubmit={create}>
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Input label="账号" value={form.username}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, username: event.target.value })} />
            </GridItem>
            <GridItem>
              <Input label="显示名称" value={form.displayName}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, displayName: event.target.value })} />
            </GridItem>
            <GridItem>
              <Input label="临时密码" type="password" placeholder="至少 10 位" value={form.password}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, password: event.target.value })} />
            </GridItem>
            <GridItem>
              <Select label="角色" value={form.role} items={[...ROLE_ITEMS]}
                onValueChange={(value: Role | null) => value && setForm({ ...form, role: value })}
                renderValue={(value: Role) => ROLE_LABEL[value]} />
            </GridItem>
          </Grid>
          <Button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建成员"}</Button>
        </form>
      </ConsoleSection>
      <ConsoleSection title="成员列表">
        <Table>
          <thead><tr><th>成员</th><th>角色</th><th>飞书</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><Text bold>{user.displayName}</Text><Text variant="secondary">{user.username}</Text></td>
                <td>{ROLE_LABEL[user.role]}</td>
                <td><Badge variant={user.feishuLinked ? "success" : "neutral"}>{user.feishuLinked ? "已关联" : "未关联"}</Badge></td>
                <td>{user.status}</td>
                <td>{new Date(user.createdAt).toLocaleString("zh-CN")}</td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan={5}><Text variant="secondary">还没有成员</Text></td></tr>}
          </tbody>
        </Table>
      </ConsoleSection>
    </Grid>
  );
}
