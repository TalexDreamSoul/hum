"use client";

import { useState } from "react";
import { Banner, Button, Grid, Input, LinkButton } from "@cloudflare/kumo";

export function LoginForm({ feishuReady, initialError }: { feishuReady: boolean; initialError?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "登录失败");
      window.location.assign("/console");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Grid gap="sm">
        {error && <Banner variant="error" title={error} />}
        <Input label="账号" autoComplete="username" value={username}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)} />
        <Input label="密码" type="password" autoComplete="current-password" value={password}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)} />
        <Button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</Button>
        {feishuReady && (
          <LinkButton variant="secondary" href="/api/auth/feishu/start?mode=login&returnTo=/console">
            使用已关联的飞书账号登录
          </LinkButton>
        )}
      </Grid>
    </form>
  );
}
