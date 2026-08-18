"use client";

/**
 * 问题时段：可交互时间轴。
 * 短期响度曲线打底，三类问题时段用彩色区块叠加（响度越界/音域越界/无留白段），
 * 支持缩放（dataZoom）、悬停解释；点击图上任意位置 → 音频跳到该时刻；
 * 播放进度以竖线实时回画到图上。
 */

import { useMemo, useRef } from "react";
import { Badge, Button } from "@cloudflare/kumo";
import type { AnalysisReport } from "@/lib/analysis/engine";
import { SCENES, type SceneKey } from "@/lib/analysis/score";
import { deriveProblems, PROBLEM_LABELS, type ProblemSpan } from "@/lib/analysis/problems";
import { EChart, fmtTime, readTheme, type ChartTheme } from "./echart";
import type * as echartsNs from "echarts";

const alpha = (color: string, a: number) => {
  const m = color.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  const h = color.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function ProblemTimeline({
  report, scene, audioUrl,
}: { report: AnalysisReport; scene: SceneKey; audioUrl?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const problems = useMemo(() => deriveProblems(report, scene), [report, scene]);
  const dur = report.gaps.durationSec || 1;
  const target = SCENES[scene].lufsTarget;

  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(dur, t));
    void a.play().catch(() => { /* 未交互前 play 可能被拦，忽略 */ });
  };

  const dimColor = (theme: ChartTheme, d: ProblemSpan["dim"]) =>
    d === "loudness" ? theme.bad : d === "range" ? theme.warn : theme.c2;

  const build = (theme: ChartTheme) => {
    const { t, lufs } = report.loudness.shortTerm;
    const line = t.map((tt, i) => [tt, Math.max(lufs[i], -34)]);
    const markSeries = (["loudness", "range", "nogap"] as const).map((dim) => ({
      name: PROBLEM_LABELS[dim],
      type: "line" as const,
      data: [] as never[],
      color: dimColor(theme, dim),
      markArea: {
        silent: true,
        itemStyle: { color: alpha(dimColor(theme, dim), dim === "nogap" ? 0.10 : 0.16) },
        label: { show: false },
        data: problems.filter((p) => p.dim === dim).map((p) => [{ xAxis: p.start }, { xAxis: p.end }]),
      },
    }));

    const bg = (() => {
      try { return getComputedStyle(document.body).backgroundColor || "#fff"; } catch { return "#fff"; }
    })();

    return {
      animation: false,
      grid: { left: 44, right: 14, top: 30, bottom: 58 },
      legend: {
        bottom: 0, icon: "roundRect", itemWidth: 12, itemHeight: 8,
        textStyle: { color: theme.muted, fontSize: 11 },
        data: markSeries.map((s) => s.name),
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: "transparent", borderWidth: 0, padding: 0,
        formatter: (params: { axisValue: number }[]) => {
          const th = readTheme();
          const x = Number(params?.[0]?.axisValue ?? 0);
          const idx = report.loudness.shortTerm.t.findIndex((tt) => tt >= x);
          const l = idx >= 0 ? report.loudness.shortTerm.lufs[idx] : null;
          const hits = problems.filter((p) => x >= p.start && x <= p.end);
          const rows = [
            `<b>${fmtTime(x)}</b>${l !== null ? ` · ${l.toFixed(1)} LUFS` : ""}`,
            ...hits.map((h) => `<span style="color:${dimColor(th, h.dim)}">■</span> ${PROBLEM_LABELS[h.dim]}：${h.note}`),
            hits.length ? "" : "<span style='opacity:.6'>此处无扣分时段</span>",
          ].filter(Boolean);
          return `<div style="background:${bg};border:1px solid ${th.line};border-radius:6px;padding:6px 9px;font-size:12px;color:${th.fg}">${rows.join("<br/>")}</div>`;
        },
      },
      dataZoom: [
        { type: "inside", throttle: 40 },
        { type: "slider", height: 16, bottom: 24, borderColor: "transparent", backgroundColor: alpha(theme.line, 0.4), fillerColor: alpha(theme.c1, 0.18), handleSize: 14, textStyle: { color: theme.muted, fontSize: 10 } },
      ],
      xAxis: {
        type: "value", min: 0, max: dur,
        axisLabel: { color: theme.muted, formatter: (v: number) => fmtTime(v) },
        axisLine: { lineStyle: { color: theme.line } },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value", min: -34, max: -6, name: "LUFS",
        nameTextStyle: { color: theme.muted },
        axisLabel: { color: theme.muted },
        splitLine: { lineStyle: { color: alpha(theme.line, 0.7) } },
      },
      series: [
        {
          name: "短期响度", type: "line", showSymbol: false, data: line,
          lineStyle: { color: theme.c1, width: 2 }, color: theme.c1,
          areaStyle: { color: alpha(theme.c1, 0.08) },
          markArea: {
            silent: true,
            itemStyle: { color: alpha(theme.good, 0.10) },
            data: [[{ yAxis: target - 2.5 }, { yAxis: target + 2.5 }]],
            label: { show: false },
          },
          markLine: {
            symbol: "none", silent: true,
            lineStyle: { color: theme.c2, width: 1.5 },
            label: { show: false },
            data: [] as { xAxis: number }[],
          },
        },
        ...markSeries,
      ],
    };
  };

  const onInit = (chart: echartsNs.ECharts) => {
    const zr = chart.getZr();
    const click = (e: { offsetX: number; offsetY: number }) => {
      const p = chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
      if (p && Number.isFinite(p[0])) seek(p[0]);
    };
    zr.on("click", click);

    const a = audioRef.current;
    let raf = 0;
    const tick = () => {
      if (a && !a.paused) {
        chart.setOption({ series: [{ markLine: { data: [{ xAxis: a.currentTime }] } }] });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => { zr.off("click", click); cancelAnimationFrame(raf); };
  };

  return (
    <div>
      {audioUrl && (
        <audio ref={audioRef} controls src={audioUrl} preload="metadata" className="mb-2 w-full" />
      )}
      <EChart build={build} height={280} onInit={onInit} deps={[report, scene, audioUrl]} />
      <p className="mt-1 mb-2 text-xs text-kumo-subtle">
        绿色横带 = 响度目标区；彩色竖带 = 扣分时段。滚轮/下方滑块缩放，点击图面跳到对应时刻播放。
        节奏、重复、频谱是全曲统计量，没有可归因的单一时段，不在此图。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {problems.length === 0 && <Badge variant="success">全程无可定位的扣分时段</Badge>}
        {problems.map((p, i) => (
          <Button key={i} variant="secondary" size="sm" onClick={() => seek(p.start)} title={p.note}>
            {fmtTime(p.start)}–{fmtTime(p.end)} {PROBLEM_LABELS[p.dim]}
          </Button>
        ))}
      </div>
    </div>
  );
}
