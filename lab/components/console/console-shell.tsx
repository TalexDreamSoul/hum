"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  GearSixIcon,
  FlaskIcon,
  ChartBarIcon,
  BookOpenTextIcon,
  BellRingingIcon,
  HouseIcon,
  ListChecksIcon,
  MusicNotesSimpleIcon,
  MusicNotesPlusIcon,
  SpeakerHighIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { AppShell, type NavGroup } from "@/components/app-shell";
import { LogoutButton } from "@/components/console/logout-button";

const ROLE_LABEL: Record<string, string> = {
  admin: "A 级管理员",
  approver: "B 级复审员",
  uploader: "C 级创作者",
};

function consoleGroups(role: string): NavGroup[] {
  const workspace = [
    { href: "/console", label: "概览", icon: HouseIcon, exact: true },
    { href: "/console/songs", label: "歌曲入库", icon: MusicNotesSimpleIcon },
    { href: "/console/reports", label: "评分报告", icon: ChartBarIcon },
  ];
  if (role === "admin" || role === "approver") {
    workspace.push(
      { href: "/console/production", label: "生产实验", icon: FlaskIcon },
      { href: "/console/jobs", label: "任务队列", icon: ListChecksIcon },
    );
  }

  const governance = [
    { href: "/console/knowledge", label: "知识库", icon: BookOpenTextIcon },
    { href: "/console/catalog", label: "出版目录", icon: MusicNotesSimpleIcon },
    { href: "/console/media", label: "媒体资产", icon: ListChecksIcon },
    { href: "/console/pipelines", label: "生产管线", icon: FlaskIcon },
    { href: "/console/governance", label: "内容治理", icon: ChartBarIcon },
  ];

  const groups: NavGroup[] = [
    { label: "工作台", items: workspace },
    { label: "内容与治理", items: governance },
  ];
  if (role === "admin") {
    groups.push({
      label: "管理",
      items: [
        { href: "/console/users", label: "成员管理", icon: UsersThreeIcon },
        { href: "/console/skills", label: "Skills", icon: BookOpenTextIcon },
        { href: "/console/model-lab", label: "模型实验室", icon: MusicNotesPlusIcon },
        { href: "/console/notifications", label: "飞书通知", icon: BellRingingIcon },
        { href: "/console/settings", label: "系统配置", icon: GearSixIcon },
      ],
    });
  }
  groups.push({
    label: "账户",
    items: [{ href: "/console/profile", label: "个人资料", icon: UserCircleIcon }],
  });
  groups.push({
    label: "公共页",
    items: [{ href: "/", label: "试听与调研", icon: SpeakerHighIcon }],
  });
  return groups;
}

export function ConsoleShell({
  children,
  displayName,
  role,
}: {
  children: ReactNode;
  displayName: string;
  role: string;
}) {
  const pathname = usePathname();
  return (
    <AppShell
      groups={consoleGroups(role)}
      pathname={pathname}
      identity={{ displayName, roleLabel: ROLE_LABEL[role] ?? role }}
      footer={<LogoutButton sidebar />}
    >
      {children}
    </AppShell>
  );
}
