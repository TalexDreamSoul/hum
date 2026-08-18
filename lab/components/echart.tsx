"use client";

/**
 * echarts 薄封装。echarts 是 Kumo 官方图表引擎（peer dependency），
 * 这里直接驱动它以获得完整交互能力；配色从 CSS 变量读取，深浅色自动重渲。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export interface ChartTheme {
  c1: string; c2: string; c3: string; c4: string;
  good: string; warn: string; bad: string;
  fg: string; muted: string; line: string;
}

export function readTheme(): ChartTheme {
  // 注意：getComputedStyle 读自定义属性拿到的是未解析的 light-dark(...) 原文，
  // echarts 不认；必须用探针元素把变量落到真实 color 上再读回 rgb。
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const v = (name: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${name}, ${fallback})`;
    return getComputedStyle(probe).color || fallback;
  };
  const fg = getComputedStyle(document.body).color || "#1c1c1a";
  const theme = {
    c1: v("--c1", "#2a78d6"), c2: v("--c2", "#eb6834"),
    c3: v("--c3", "#1baf7a"), c4: v("--c4", "#eda100"),
    good: v("--good", "#1baf7a"), warn: v("--warn", "#eda100"), bad: v("--bad", "#e34948"),
    fg, muted: fg.startsWith("rgb(") ? fg.replace("rgb(", "rgba(").replace(")", ",0.6)") : fg, line: v("--chart-line", "#e3e3df"),
  };
  probe.remove();
  return theme;
}

interface EChartProps {
  /** 用当前主题构建 echarts option；主题切换时会被重新调用 */
  build: (theme: ChartTheme, ec: typeof echarts) => Record<string, unknown>;
  height?: number;
  /** 图表初始化后回调（挂交互事件用） */
  onInit?: (chart: echarts.ECharts) => void | (() => void);
  /** 变更依赖：内容变化时重建 option */
  deps?: unknown[];
}

export function EChart({ build, height = 260, onInit, deps = [] }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    let cleanup: void | (() => void);

    const render = () => chart.setOption(build(readTheme(), echarts) as never, true);
    render();
    cleanup = onInit?.(chart);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", render);

    return () => {
      mq.removeEventListener("change", render);
      ro.disconnect();
      if (typeof cleanup === "function") cleanup();
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
};
