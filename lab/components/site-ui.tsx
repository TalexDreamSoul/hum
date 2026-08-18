/**
 * 公共页的页面骨架：直接复用后台那套 Kumo 组件（ConsolePage / ConsoleSection），
 * 保证公共页和内容后台是同一个版心、同一种标题层级、同一种卡片。
 * 这里只补公共页特有的小件：术语表、指标块、正文段落、列表。
 */

import type { ReactNode } from "react";
import { Grid, GridItem, Table, Text } from "@cloudflare/kumo";
import { ConsolePage, ConsoleSection } from "@/components/console/console-ui";

const PROSE = "max-w-prose";

export function SitePage({
  kicker,
  title,
  lede,
  children,
}: {
  kicker?: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsolePage title={title} description={lede ?? kicker ?? ""}>
      {children}
    </ConsolePage>
  );
}

/** 普通分节：和后台的分区卡片同一个组件。 */
export function SiteSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <ConsoleSection title={title}>
      <Grid gap="sm">
        {description && (
          <Grid gap="sm" className={PROSE}>
            <Text variant="secondary">{description}</Text>
          </Grid>
        )}
        {children}
      </Grid>
    </ConsoleSection>
  );
}

export const SiteCard = ConsoleSection;

/** 指标块：一个数字加一句解释。 */
export function SiteMetric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <GridItem>
      <Text variant="secondary" size="xs">{label}</Text>
      <Text variant="heading3" as="p">{value}</Text>
      {note && <Text variant="secondary" size="xs">{note}</Text>}
    </GridItem>
  );
}

/** 术语解释用两列表格，替代 dl/dt/dd 的手写排版。 */
export function SiteDefinitions({ items }: { items: Array<{ term: ReactNode; description: ReactNode }> }) {
  return (
    <Table>
      <thead><tr><th>名词</th><th>说明</th></tr></thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index}>
            <td><Text bold>{item.term}</Text></td>
            <td><Text variant="secondary">{item.description}</Text></td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** 正文段落：页面里不再直接写 <p className="…">。 */
export function SiteText({ children, secondary }: { children: ReactNode; secondary?: boolean }) {
  return (
    <Grid gap="sm" className={PROSE}>
      <Text variant={secondary ? "secondary" : "body"} as="p">{children}</Text>
    </Grid>
  );
}

export function SiteList({ items, secondary }: { items: ReactNode[]; secondary?: boolean }) {
  return (
    <Grid gap="sm" className={PROSE}>
      {items.map((item, index) => (
        <Text key={index} variant={secondary ? "secondary" : "body"} size="sm" as="li">{item}</Text>
      ))}
    </Grid>
  );
}

const RESEARCH_PAGES = [
  { href: "/", label: "试听主页" },
  { href: "/apps", label: "100 款分析" },
  { href: "/competitors", label: "赛道格局" },
  { href: "/pricing", label: "内容与变现" },
  { href: "/analytics", label: "数据平台" },
  { href: "/lab", label: "分析工具" },
  { href: "/methodology", label: "评分原理" },
] as const;

/** 侧边栏已经承担导航，页脚只留一句归属说明。 */
export function SiteFooterNav({ current }: { current: string }) {
  const others = RESEARCH_PAGES.filter((page) => page.href !== current).length;
  return (
    <Text variant="secondary" size="xs">
      hum · 内部页面，未对外公开索引 · 另有 {others} 个页面在左侧导航
    </Text>
  );
}
