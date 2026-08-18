"use client";

/** 100 款儿童 App 交叉分析——数据来自 App Store 官方接口（2026-08-12 采集）。 */

import { useMemo, useState } from "react";
import { Banner, LayerCard, Table } from "@cloudflare/kumo";
import { EChart, type ChartTheme } from "@/components/echart";
import { ResearchNav } from "@/components/doc";
import DATA from "@/lib/apps-data.json";

interface AppRow {
  name: string; seller: string; cat: string; audio: boolean;
  ratings: number; avg: number | null; years: number | null;
  upd: number | null; perday: number | null; size: number | null;
  free: number | null; gross: number | null;
}

const alpha = (color: string, a: number) => {
  const m = color.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return color;
};

const fmt = (n: number) => n.toLocaleString("zh-CN");

export default function Page() {
  const apps = DATA.apps as AppRow[];
  const [sortKey, setSortKey] = useState<keyof AppRow>("ratings");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const s = [...apps].sort((a, b) => {
      const A = a[sortKey], B = b[sortKey];
      if (typeof A === "string" && typeof B === "string") return A.localeCompare(B, "zh");
      return ((A as number) ?? -1) - ((B as number) ?? -1);
    });
    return asc ? s : s.reverse();
  }, [apps, sortKey, asc]);

  const clickSort = (k: keyof AppRow) => {
    if (k === sortKey) setAsc(!asc);
    else { setSortKey(k); setAsc(false); }
  };

  const cumBuild = (t: ChartTheme) => ({
    animation: false,
    grid: { left: 44, right: 14, top: 18, bottom: 28 },
    xAxis: { type: "value", min: 1, max: 100, axisLabel: { color: t.muted }, splitLine: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    yAxis: { type: "value", min: 0, max: 100, axisLabel: { color: t.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: alpha(t.line, 0.7) } } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `${v}%` },
    series: [{
      type: "line", showSymbol: false, data: DATA.cum.map((c: { n: number; pct: number }) => [c.n, c.pct]),
      lineStyle: { color: t.c1, width: 2 }, color: t.c1, areaStyle: { color: alpha(t.c1, 0.08) },
      markPoint: {
        symbolSize: 1, label: { color: t.fg, fontSize: 11, fontWeight: 600 },
        data: [5, 10, 20, 50].map((k) => {
          const c = (DATA.cum as { n: number; pct: number }[])[k - 1];
          return { coord: [c.n, c.pct], value: `前${k} ${c.pct}%` };
        }),
      },
    }],
  });

  const catBuild = (t: ChartTheme) => {
    const cats = DATA.cats as { cat: string; count: number; median: number }[];
    return {
      animation: false,
      grid: [{ left: 90, width: "34%", top: 24, bottom: 8 }, { left: "58%", right: 70, top: 24, bottom: 8 }],
      xAxis: [
        { gridIndex: 0, type: "value", inverse: true, show: false },
        { gridIndex: 1, type: "value", show: false },
      ],
      yAxis: [
        { gridIndex: 0, type: "category", data: cats.map((c) => c.cat), axisLabel: { color: t.fg }, axisLine: { show: false }, axisTick: { show: false }, inverse: true },
        { gridIndex: 1, type: "category", data: cats.map((c) => c.cat), axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, inverse: true },
      ],
      tooltip: { trigger: "axis" },
      title: [
        { text: "款数", left: 60, top: 0, textStyle: { fontSize: 11, color: t.muted, fontWeight: 400 } },
        { text: "单款中位评分数", left: "58%", top: 0, textStyle: { fontSize: 11, color: t.muted, fontWeight: 400 } },
      ],
      series: [
        { name: "款数", type: "bar", xAxisIndex: 0, yAxisIndex: 0, data: cats.map((c) => c.count), itemStyle: { color: t.c1, borderRadius: 3 }, label: { show: true, position: "left", color: t.fg }, barWidth: 12 },
        { name: "单款中位", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: cats.map((c) => c.median), itemStyle: { color: t.c3, borderRadius: 3 }, label: { show: true, position: "right", color: t.fg, formatter: (p: { value: number }) => fmt(p.value) }, barWidth: 12 },
      ],
    };
  };

  const barBuild = (rows: { label: string; count?: number; k?: number }[], color: keyof ChartTheme) => (t: ChartTheme) => ({
    animation: false,
    grid: { left: 100, right: 56, top: 8, bottom: 8 },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", data: rows.map((r) => r.label), axisLabel: { color: t.fg }, axisLine: { show: false }, axisTick: { show: false }, inverse: true },
    series: [{
      type: "bar", data: rows.map((r) => r.count ?? r.k ?? 0),
      itemStyle: { color: t[color] as string, borderRadius: 3 }, barWidth: 13,
      label: { show: true, position: "right", color: t.fg, formatter: (p: { value: number }) => `${p.value} 款` },
    }],
  });

  const heroes = [
    { v: `${DATA.concentration["20"]}%`, k: "前 20 名占全部评分数" },
    { v: `${(DATA.agebuck as { count: number }[])[0].count} 款`, k: "近 3 年上线的新品" },
    { v: `${DATA.audio.share_ratings}%`, k: "音频型占评分数份额" },
  ];

  const cols: { k: keyof AppRow; label: string }[] = [
    { k: "name", label: "名称" }, { k: "cat", label: "赛道" }, { k: "ratings", label: "评分数" },
    { k: "avg", label: "均分" }, { k: "years", label: "上线年" }, { k: "upd", label: "距更新天" },
    { k: "perday", label: "日均积累" },
  ];

  return (
    <main className="wrap py-8">
      <p className="text-xs text-kumo-subtle">hum · 数据分析 · 2026-08-12</p>
      <h1 className="mt-1">100 款儿童 App 交叉分析</h1>
      <p className="mt-2 text-kumo-subtle" style={{ maxWidth: "38rem" }}>
        样本取自 App Store 中国区教育免费榜、畅销榜、iPad 榜与 20 组儿童关键词，
        清洗后按评分数取前 100。全部为苹果官方接口的一手数据。
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        {heroes.map((h) => (
          <LayerCard key={h.k} className="rounded-lg p-4" style={{ minWidth: "11rem" }}>
            <p className="m-0 text-lg font-medium tabular-nums">{h.v}</p>
            <p className="m-0 text-xs text-kumo-subtle">{h.k}</p>
          </LayerCard>
        ))}
      </div>
      <div className="mt-3 grid gap-2" style={{ maxWidth: "44rem" }}>
        <Banner variant="alert" title="这个品类已经固化了：100 款里只有 1 款是近 3 年上线的，中位上线年限 8.6 年。" description="新玩家几乎进不来——要么壁垒极高，要么增长红利已经结束。" />
        <Banner variant="default" title="但音频型是个例外：只占 22% 的数量，却占 38% 的评分数。" description="同样一款产品，音频形态的规模显著更大。" />
      </div>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>头部吃掉几乎全部</h2>
        <EChart build={cumBuild} height={220} deps={[]} />
        <p className="mt-1 text-xs text-kumo-subtle">横轴为按评分数排名的前 N 款，纵轴为它们占总评分数的比例。前 5 名占 33.6%，前 50 名占 92.1%，后 50 名合计不到 8%。</p>
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>最拥挤的赛道不是最肥的</h2>
        <EChart build={catBuild} height={330} deps={[]} />
        <div className="mt-2" style={{ maxWidth: "44rem" }}>
          <Banner variant="default" title="识字拼音 22 款最挤，单款中位只有 2.3 万评分；绘本阅读 7 款，单款中位 19.5 万——是识字类的 8 倍。" description="人多的地方不一定有肉。这条同样适用于选切入点。" />
        </div>
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>近三年几乎没有新玩家</h2>
        <EChart build={barBuild(DATA.agebuck as { label: string; count: number }[], "c2")} height={190} deps={[]} />
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>四成产品处在维护状态</h2>
        <EChart build={barBuild(DATA.updbuck as { label: string; count: number }[], "c4")} height={190} deps={[]} />
        <p className="mt-1 text-xs text-kumo-subtle">46% 在 30 天内更新过，主力仍在活跃维护；13% 超过一年没动，是事实上的弃管产品。</p>
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>一家公司铺一堆号</h2>
        <EChart build={barBuild((DATA.sellers as { s: string; k: number }[]).map((s) => ({ label: s.s.length > 14 ? s.s.slice(0, 14) + "…" : s.s, k: s.k })), "c1")} height={300} deps={[]} />
        <p className="mt-1 text-xs text-kumo-subtle">洪恩系 8 款、Bimi Boo 8 款、宝宝巴士 6 款——头部玩家用矩阵占位，同一批内容拆成多个 App 分别做 ASO。100 款来自 63 家开发商。</p>
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>全部 100 款（点表头排序）</h2>
        <div className="mt-2 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.k} className="cursor-pointer whitespace-nowrap" onClick={() => clickSort(c.k)}>
                    {c.label}{sortKey === c.k ? (asc ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((x) => (
                <tr key={x.name}>
                  <td>{x.name.slice(0, 24)}{x.audio ? " ♪" : ""}</td>
                  <td className="text-kumo-subtle">{x.cat}</td>
                  <td className="tabular-nums">{fmt(x.ratings)}</td>
                  <td className="tabular-nums">{x.avg ?? "–"}</td>
                  <td className="tabular-nums">{x.years ?? "–"}</td>
                  <td className="tabular-nums">{x.upd ?? "–"}</td>
                  <td className="tabular-nums">{x.perday ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>

      <section className="mt-6 border-t border-kumo-line pt-4">
        <h2>数据边界</h2>
        <p className="m-0 text-xs text-kumo-subtle" style={{ maxWidth: "42rem" }}>
          仅覆盖 App Store 中国区 iOS，不含安卓。「评分数」是累计量，不等于活跃用户——十年老产品的评分里包含早已流失的用户。
          赛道归类由名称关键词规则判定。「日均积累」= 累计评分数 ÷ 上线天数，是平均速度不是当前速度。
          下载量与收入不在本数据集内；第三方平台的估算彼此差异可达 2 倍以上。
        </p>
      </section>

      <ResearchNav current="/apps" />
    </main>
  );
}
