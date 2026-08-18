"use client";

import { useState } from "react";
import { Banner, Button, Grid, Input } from "@cloudflare/kumo";

export function SetupForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [values, setValues] = useState({ setupCode: "", username: "", displayName: "", password: "" });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "初始化失败");
      window.location.assign("/console");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Grid gap="sm">
        {error && <Banner variant="error" title={error} />}
        <Input label="初始化码" type="password" autoComplete="one-time-code" value={values.setupCode}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, setupCode: event.target.value })} />
        <Input label="管理员账号" autoComplete="username" placeholder="admin" value={values.username}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, username: event.target.value })} />
        <Input label="显示名称" autoComplete="name" placeholder="内容管理员" value={values.displayName}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, displayName: event.target.value })} />
        <Input label="管理员密码" type="password" autoComplete="new-password" placeholder="至少 10 位" value={values.password}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, password: event.target.value })} />
        <Button type="submit" disabled={busy}>{busy ? "正在初始化…" : "创建管理员并进入后台"}</Button>
      </Grid>
    </form>
  );
}
