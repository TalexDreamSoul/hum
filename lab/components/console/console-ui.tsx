"use client";

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button, Dialog, Grid, LayerCard, Pagination, Text, useKumoToastManager } from "@cloudflare/kumo";

export function ConsoleDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="xl">
        <Grid gap="base">
          {/* 关闭按钮放最前面，抽屉打开时焦点落在这里，不会被内部输入框拽着滚下去 */}
          <Dialog.Close render={(props) => <Button variant="secondary" size="sm" {...props}>关闭</Button>} />
          <Dialog.Title>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
          {children}
        </Grid>
      </Dialog>
    </Dialog.Root>
  );
}

const PAGE_LABELS = {
  firstPage: "第一页",
  previousPage: "上一页",
  nextPage: "下一页",
  lastPage: "最后一页",
  pageNumber: "页码",
  pageSize: "每页条数",
};

export function ConsolePagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  return (
    <Pagination page={page} setPage={onPage} perPage={pageSize} totalCount={total} labels={PAGE_LABELS}>
      <Pagination.Info>
        {({ pageShowingRange, totalCount }) => <>第 {pageShowingRange} 条，共 {totalCount ?? 0} 条</>}
      </Pagination.Info>
      <Pagination.PageSize label="每页" value={pageSize} onChange={onPageSize} options={[10, 20, 50]} />
      <Pagination.Controls />
    </Pagination>
  );
}

/** 列表统一分页：数据量小的先在前端切片，接口分页后换成服务端游标即可。 */
export function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

/** 后台统一的轻提示：成功、失败都走 toast，页面里只留常驻状态用的 Banner。 */
export function useConsoleToast() {
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const success = useCallback((title: string, description?: string) => {
    toastsRef.current.add({ title, description, variant: "success" });
  }, []);
  const error = useCallback((title: string, description?: string) => {
    toastsRef.current.add({ title, description, variant: "error" });
  }, []);
  const info = useCallback((title: string, description?: string) => {
    toastsRef.current.add({ title, description, variant: "info" });
  }, []);

  return useMemo(() => ({ success, error, info }), [success, error, info]);
}

export function ConsolePage({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    // 内容区限宽，避免超宽屏上表单被拉成一整行。
    <Grid gap="base">
      <Text variant="heading1" as="h1">{title}</Text>
      <Text variant="secondary">{description}</Text>
      {children}
    </Grid>
  );
}

export function ConsoleSection({
  title,
  status,
  children,
}: {
  title: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <Text variant="heading3" as="h2">{title}</Text>
        {status}
      </LayerCard.Secondary>
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

export function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <Text variant="secondary">{label}</Text>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <Text variant="heading2" as="span">{value}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
