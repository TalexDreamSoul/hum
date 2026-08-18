"use client";

import { Button, Sidebar } from "@cloudflare/kumo";
import { SignOutIcon } from "@phosphor-icons/react";

export function LogoutButton({ sidebar = false }: { sidebar?: boolean }) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }
  if (sidebar) {
    return <Sidebar.MenuButton icon={SignOutIcon} onClick={logout}>退出登录</Sidebar.MenuButton>;
  }
  return <Button size="sm" variant="ghost" onClick={logout}>退出</Button>;
}
