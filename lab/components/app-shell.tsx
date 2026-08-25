"use client";

/**
 * 全站唯一的外壳：公共页和内容后台共用同一个 Kumo Sidebar + LayerCard 框架。
 * 以前公共页是自己的顶部导航加 .wrap 版心，后台是侧边栏，两套观感；现在只有一套。
 */

import NextLink from "next/link";
import { forwardRef, type ReactNode } from "react";
import {
  Badge,
  LayerCard,
  LinkProvider,
  Sidebar,
  Text,
  Toasty,
  type LinkComponentProps,
} from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";

const KumoNextLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to, ...props }, ref) => (
  <NextLink ref={ref} href={href ?? to ?? ""} {...props} />
));
KumoNextLink.displayName = "KumoNextLink";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function routeIsActive(pathname: string, href: string, exact = false): boolean {
  return pathname === href || (!exact && href !== "/" && pathname.startsWith(`${href}/`));
}

export function AppShell({
  children,
  groups,
  pathname,
  identity,
  footer,
}: {
  children: ReactNode;
  groups: NavGroup[];
  pathname: string;
  /** 后台会显示当前登录人和角色；公共页不传。 */
  identity?: { displayName: string; roleLabel: string };
  footer?: ReactNode;
}) {
  const currentItem = groups
    .flatMap((group) => group.items)
    .reduce<NavItem | undefined>((best, item) => {
      if (!routeIsActive(pathname, item.href, item.exact)) return best;
      return !best || item.href.length > best.href.length ? item : best;
    }, undefined);
  const currentPage = currentItem?.label ?? "hum";

  return (
    <LinkProvider component={KumoNextLink}>
      <Toasty>
        <Sidebar.Provider defaultOpen collapsible="offcanvas">
          <Sidebar fullScreenOnMobile>
            <Sidebar.Header>
              <Text as="span" bold>hum</Text>
              <Text as="span" variant="secondary" size="xs">学习 × 音乐</Text>
            </Sidebar.Header>
            <Sidebar.Content>
              {groups.map((group) => (
                <Sidebar.Group key={group.label}>
                  <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
                  <Sidebar.Menu>
                    {group.items.map((item) => {
                      const active = item.href === currentItem?.href;
                      return (
                        <Sidebar.MenuButton
                          key={item.href}
                          href={item.href}
                          icon={item.icon}
                          active={active}
                          aria-current={active ? "page" : undefined}
                        >
                          {item.label}
                        </Sidebar.MenuButton>
                      );
                    })}
                  </Sidebar.Menu>
                </Sidebar.Group>
              ))}
            </Sidebar.Content>
            {footer && (
              <Sidebar.Footer>
                <Sidebar.Menu>{footer}</Sidebar.Menu>
              </Sidebar.Footer>
            )}
          </Sidebar>
          <LayerCard render={<main />}>
            <LayerCard.Secondary>
              <Sidebar.Trigger aria-label="切换侧边导航" />
              <Text as="span" bold>{currentPage}</Text>
              {identity && <Text as="span" variant="secondary">{identity.displayName}</Text>}
              {identity && <Badge variant="neutral">{identity.roleLabel}</Badge>}
            </LayerCard.Secondary>
            <LayerCard.Primary>{children}</LayerCard.Primary>
          </LayerCard>
        </Sidebar.Provider>
      </Toasty>
    </LinkProvider>
  );
}
