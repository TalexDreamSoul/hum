"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  ChartBarIcon,
  ChartPieSliceIcon,
  CurrencyCnyIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  SpeakerHighIcon,
  TargetIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { AppShell, type NavGroup } from "@/components/app-shell";

/** 公共页的侧边栏分组；内容后台在最后一组，点进去就是同一个外壳。 */
const PUBLIC_GROUPS: NavGroup[] = [
  {
    label: "试听与工具",
    items: [
      { href: "/", label: "试听主页", icon: SpeakerHighIcon },
      { href: "/lab", label: "分析工具", icon: WaveformIcon },
      { href: "/methodology", label: "评分原理", icon: TargetIcon },
    ],
  },
  {
    label: "调研",
    items: [
      { href: "/apps", label: "100 款分析", icon: MagnifyingGlassIcon },
      { href: "/competitors", label: "赛道格局", icon: ChartBarIcon },
      { href: "/pricing", label: "内容与变现", icon: CurrencyCnyIcon },
      { href: "/analytics", label: "数据平台", icon: ChartPieSliceIcon },
    ],
  },
  {
    label: "内部",
    items: [{ href: "/console", label: "内容后台", icon: GearSixIcon }],
  },
];

export function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // 后台自己带外壳；登录和初始化页保持无壳的单卡片布局。
  const bare = pathname.startsWith("/console") || pathname === "/login" || pathname === "/setup";
  if (bare) return <>{children}</>;

  return <AppShell groups={PUBLIC_GROUPS} pathname={pathname}>{children}</AppShell>;
}
