/** 调研文档页的公共骨架：直接复用 site-ui 的 Kumo 组件，不再手写排版。 */

import type { ReactNode } from "react";
import { Text } from "@cloudflare/kumo";
import { SiteFooterNav, SitePage, SiteSection } from "@/components/site-ui";

export function DocPage({
  kicker, title, lede, children,
}: { kicker: string; title: string; lede: ReactNode; children: ReactNode }) {
  return <SitePage kicker={kicker} title={title} lede={lede}>{children}</SitePage>;
}

export function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return <SiteSection title={title}>{children}</SiteSection>;
}

export function Dt({ children }: { children: ReactNode }) {
  return <Text bold as="dt">{children}</Text>;
}

export function Dd({ children }: { children: ReactNode }) {
  return <Text variant="secondary" size="sm" as="dd">{children}</Text>;
}

export function ResearchNav({ current }: { current: string }) {
  return <SiteFooterNav current={current} />;
}
