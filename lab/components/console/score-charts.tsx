"use client";

/**
 * 评分图表：一首歌的分数趋势 + 单个候选的维度雷达。
 * 复用 /lab 那套 echarts 封装（配色读 CSS 变量，深浅色自动重渲）。
 */

import { Grid, Text } from "@cloudflare/kumo";
import { EChart } from "@/components/echart";

export interface ScorePoint {
  label: string;
  total: number | null;
  passed: boolean | null;
}

export interface DimPoint {
  label: string;
  score: number | null;
  weight?: number;
}

/** 分数趋势：每次候选一个点，门槛画成参考线。 */
export function ScoreTrend({ points, threshold = 70, height = 220 }: { points: ScorePoint[]; threshold?: number; height?: number }) {
  const usable = points.filter((point) => typeof point.total === "number");
  if (usable.length < 1) return <Text variant="secondary">还没有可画的评分。</Text>;

  return (
    <EChart
      height={height}
      deps={[JSON.stringify(points), threshold]}
      build={(theme) => ({
        grid: { left: 40, right: 16, top: 24, bottom: 28 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: usable.map((point) => point.label),
          axisLine: { lineStyle: { color: theme.line } },
          axisLabel: { color: theme.muted },
        },
        yAxis: {
          type: "value",
          min: 0,
          max: 100,
          splitLine: { lineStyle: { color: theme.line } },
          axisLabel: { color: theme.muted },
        },
        series: [
          {
            type: "line",
            name: "总分",
            data: usable.map((point) => ({
              value: point.total,
              itemStyle: { color: point.passed ? theme.good : theme.warn },
            })),
            smooth: false,
            symbolSize: 9,
            lineStyle: { color: theme.c1, width: 2 },
            label: { show: true, color: theme.fg, formatter: "{c}" },
            markLine: {
              silent: true,
              symbol: "none",
              data: [{ yAxis: threshold, label: { formatter: `门槛 ${threshold}`, color: theme.muted } }],
              lineStyle: { color: theme.bad, type: "dashed" },
            },
          },
        ],
      })}
    />
  );
}

/** 维度雷达：8 个维度对着门槛看，哪一角塌了一眼就见。 */
export function DimensionRadar({ dims, threshold = 70, height = 300 }: { dims: DimPoint[]; threshold?: number; height?: number }) {
  const usable = dims.filter((dim) => typeof dim.score === "number");
  if (usable.length < 3) return <Text variant="secondary">维度数据不足，画不了雷达图。</Text>;

  return (
    <EChart
      height={height}
      deps={[JSON.stringify(dims), threshold]}
      build={(theme) => ({
        tooltip: {},
        radar: {
          indicator: usable.map((dim) => ({ name: dim.label, max: 100 })),
          axisName: { color: theme.muted },
          splitLine: { lineStyle: { color: theme.line } },
          axisLine: { lineStyle: { color: theme.line } },
          splitArea: { show: false },
        },
        series: [
          {
            type: "radar",
            data: [
              {
                name: "本次得分",
                value: usable.map((dim) => dim.score),
                lineStyle: { color: theme.c1 },
                itemStyle: { color: theme.c1 },
                areaStyle: { color: theme.c1, opacity: 0.18 },
              },
              {
                name: `门槛 ${threshold}`,
                value: usable.map(() => threshold),
                lineStyle: { color: theme.bad, type: "dashed" },
                itemStyle: { color: theme.bad },
                symbol: "none",
              },
            ],
          },
        ],
        legend: { bottom: 0, textStyle: { color: theme.muted } },
      })}
    />
  );
}

/** 维度对比：改进前后每个维度的变化，柱状并排。 */
export function DimensionCompare({
  before,
  after,
  height = 260,
}: {
  before: { label: string; dims: DimPoint[] };
  after: { label: string; dims: DimPoint[] };
  height?: number;
}) {
  const labels = before.dims.map((dim) => dim.label);
  if (!labels.length) return <Text variant="secondary">没有可对比的维度。</Text>;
  const afterByLabel = new Map(after.dims.map((dim) => [dim.label, dim.score]));

  return (
    <Grid gap="sm">
      <EChart
        height={height}
        deps={[JSON.stringify(before), JSON.stringify(after)]}
        build={(theme) => ({
          grid: { left: 40, right: 16, top: 32, bottom: 60 },
          tooltip: { trigger: "axis" },
          legend: { top: 0, textStyle: { color: theme.muted } },
          xAxis: {
            type: "category",
            data: labels,
            axisLabel: { color: theme.muted, interval: 0, rotate: 30 },
            axisLine: { lineStyle: { color: theme.line } },
          },
          yAxis: { type: "value", min: 0, max: 100, splitLine: { lineStyle: { color: theme.line } }, axisLabel: { color: theme.muted } },
          series: [
            { type: "bar", name: before.label, data: before.dims.map((dim) => dim.score), itemStyle: { color: theme.c4 } },
            { type: "bar", name: after.label, data: labels.map((label) => afterByLabel.get(label) ?? null), itemStyle: { color: theme.c1 } },
          ],
        })}
      />
    </Grid>
  );
}
