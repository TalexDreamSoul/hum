"use client";

/**
 * 富报告卡：仪表盘总分 + 雷达 + 维度 Meter/明细表 + 可交互问题时段 + 歌词分析。
 * 布局与样式全部使用 Kumo 组件及其自带工具类；图表用 echarts（Kumo 官方图表引擎）。
 */

import { useMemo, useState } from "react";
import { Badge, Banner, Button, buttonVariants, LayerCard, Meter, Table, Tabs } from "@cloudflare/kumo";
import type { AnalysisReport } from "@/lib/analysis/engine";
import { computeScore, SCENES, type SceneKey } from "@/lib/analysis/score";
import type { LyricsLocal } from "@/lib/lrc";
import type { LyricsAIResult } from "@/lib/ai";
import { EChart, fmtTime, type ChartTheme } from "./echart";
import { ProblemTimeline } from "./timeline";

export interface LyricsBundle {
  raw: string;
  local: LyricsLocal | null;
  ai?: LyricsAIResult;
}

interface ReportCardProps {
  report: AnalysisReport;
  scene: SceneKey;
  audioUrl?: string;
  lyrics?: LyricsBundle | null;
  readonly?: boolean;
  onAttachLrc?: (file: File) => void;
  onRunAI?: () => void;
  aiBusy?: boolean;
  aiError?: string | null;
  hasAIConfig?: boolean;
  onOpenAISettings?: () => void;
  onShare?: () => void;
  shareBusy?: boolean;
  shareUrl?: string | null;
  shareError?: string | null;
}

const alpha = (color: string, a: number) => {
  const m = color.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  const h = color.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const gradeVariant = (g: string) =>
  g === "A" ? ("success" as const) : g === "B" ? ("info" as const) : g === "C" ? ("warning" as const) : ("error" as const);

const toneVariant = (tone: string) =>
  tone === "bad" ? ("error" as const) : tone === "warn" ? ("alert" as const) : ("default" as const);

export function ReportCard(props: ReportCardProps) {
  const { report, scene, audioUrl, lyrics, readonly } = props;
  const [tab, setTab] = useState("overview");

  const score = useMemo(
    () => computeScore(scene, report.loudness, report.tempo, report.pitch, report.spectral, report.repetition, report.gaps),
    [report, scene],
  );

  const gradeColor = (t: ChartTheme) =>
    score.total >= 85 ? t.good : score.total >= 70 ? t.c1 : score.total >= 55 ? t.warn : t.bad;

  const validDims = score.dims.filter((d) => d.score !== null);
  const wSum = validDims.reduce((a, d) => a + d.weight, 0) || 1;
  const rows = score.dims.map((d) => {
    const lost = d.score === null ? null : Math.round(((100 - d.score) * d.weight / wSum) * 10) / 10;
    return { ...d, lost };
  });
  const worst = [...rows].filter((r) => (r.lost ?? 0) >= 1).sort((a, b) => (b.lost ?? 0) - (a.lost ?? 0)).slice(0, 2);

  const exportJson = () => {
    const blob = new Blob(
      [JSON.stringify({ ...report, score, lyrics: lyrics ?? undefined }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${report.meta.name.replace(/\.[^.]+$/, "")}-analysis.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const gaugeBuild = (t: ChartTheme) => ({
    animation: true,
    series: [{
      type: "gauge", startAngle: 225, endAngle: -45, min: 0, max: 100, radius: "96%",
      progress: { show: true, width: 9, roundCap: true, itemStyle: { color: gradeColor(t) } },
      axisLine: { lineStyle: { width: 9, color: [[1, alpha(t.line, 0.9)]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: {
        valueAnimation: true, offsetCenter: [0, "8%"],
        formatter: () => `{a|${score.total}}\n{b|${score.grade} 级}`,
        rich: { a: { fontSize: 27, fontWeight: 700, color: t.fg }, b: { fontSize: 12, color: gradeColor(t) } },
      },
      data: [{ value: score.total }],
    }],
  });

  const radarBuild = (t: ChartTheme) => ({
    animation: true,
    radar: {
      indicator: score.dims.map((d) => ({ name: `${d.label}\n${d.score ?? "—"}`, max: 100 })),
      radius: "62%", center: ["50%", "52%"],
      axisName: { color: t.muted, fontSize: 11, lineHeight: 15 },
      splitLine: { lineStyle: { color: alpha(t.line, 0.9) } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: alpha(t.line, 0.9) } },
    },
    series: [{
      type: "radar", symbolSize: 4,
      data: [{
        value: score.dims.map((d) => d.score ?? 0),
        itemStyle: { color: t.c1 },
        lineStyle: { color: t.c1, width: 2 },
        areaStyle: { color: alpha(t.c1, 0.22) },
      }],
    }],
  });

  const pitchBuild = (t: ChartTheme) => {
    const { midi, count } = report.pitch.hist;
    const names = midi.map((m) => (m % 12 === 0 ? `C${m / 12 - 1}` : ""));
    return {
      animation: false,
      grid: { left: 10, right: 10, top: 24, bottom: 22 },
      xAxis: { type: "category", data: midi.map(String), axisLabel: { color: t.muted, interval: 0, formatter: (_: string, i: number) => names[i] }, axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false } },
      yAxis: { show: false },
      tooltip: { show: false },
      series: [{
        type: "bar", data: count.map((c, i) => ({ value: c, itemStyle: { color: midi[i] >= 62 && midi[i] <= 71 ? t.good : alpha(t.c1, 0.75) } })),
        barCategoryGap: "18%",
        markArea: {
          silent: true, itemStyle: { color: alpha(t.good, 0.10) },
          data: [[{ xAxis: "62" }, { xAxis: "71" }]], label: { show: false },
        },
      }],
    };
  };

  const metricRows: [string, string][] = [
    ["整体响度", `${report.loudness.integratedLufs.toFixed(1)} LUFS（目标 ${SCENES[scene].lufsTarget}±2.5）`],
    ["真峰值", `${report.loudness.truePeakDbtp.toFixed(1)} dBTP（红线 −1）`],
    ["响度范围 LRA", `${report.loudness.lra.toFixed(1)} LU`],
    ["节奏", report.tempo.bpm ? `${report.tempo.bpm} BPM（显著度 ${report.tempo.salience}）` : "未检出"],
    ["舒适唱区占比", `${Math.round(report.pitch.shareComfort * 100)}%（D4–B4）`],
    ["音域跨度", report.pitch.spanSemitones !== null ? `${report.pitch.spanSemitones} 半音` : "—"],
    ["旋律中位音高", report.pitch.medianF0 !== null ? `${report.pitch.medianF0} Hz` : "—"],
    ["清晰度带占比", `${Math.round(report.spectral.artShare * 100)}%（1–4 kHz）`],
    ["人声/伴奏（中/侧）", report.spectral.midSideArtDb !== null ? `${report.spectral.midSideArtDb} dB` : "单声道，不适用"],
    ["音节率代理", report.spectral.syllableRate !== null ? `${report.spectral.syllableRate}/s` : "—"],
    ["重复帧占比", `${Math.round(report.repetition.repeatedShare * 100)}%`],
    ["留白", `${report.gaps.gapsPerMin} 次/分 · 平均 ${report.gaps.meanGapMs ?? "—"} ms`],
    ["高频占比 >8kHz", `${Math.round(report.spectral.highShare * 100)}%`],
    ["超低频占比 <60Hz", `${Math.round(report.spectral.lowShare * 100)}%`],
    ["时长 / 采样率 / 声道", `${report.meta.durationSec}s / ${report.meta.sampleRate}Hz / ${report.meta.channels === 1 ? "单" : "立体"}声道`],
  ];

  return (
    <LayerCard className="mt-4 rounded-xl p-6">
      <div className="flex flex-wrap items-center gap-6">
        <div className="shrink-0" style={{ width: 132 }}>
          <EChart build={gaugeBuild} height={132} deps={[score.total, scene]} />
        </div>
        <div className="min-w-0 grow">
          <h2 className="flex flex-wrap items-center gap-2">
            {report.meta.name}
            <Badge variant={gradeVariant(score.grade)}>{score.grade} 级 · {score.total} 分</Badge>
            <Badge variant="neutral">{SCENES[score.scene].label}</Badge>
            {lyrics?.raw && <Badge variant="blue">含歌词</Badge>}
            {lyrics?.ai && <Badge variant="purple">AI 已析</Badge>}
          </h2>
          <p className="mt-1 mb-2 text-sm text-kumo-subtle">
            {report.meta.durationSec}s · {report.meta.sampleRate} Hz · {report.meta.channels === 1 ? "单声道" : "立体声"}
            {worst.length > 0 && <> · 主要失分：{worst.map((w) => `${w.label}（−${w.lost}）`).join("、")}</>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={exportJson}>导出 JSON</Button>
            {!readonly && props.onShare && (
              <Button variant="secondary" size="sm" onClick={props.onShare} disabled={props.shareBusy}>
                {props.shareBusy ? "上传中…" : "生成分享链接"}
              </Button>
            )}
            {props.shareUrl && (
              <a href={props.shareUrl} target="_blank" rel="noreferrer" className="text-sm">
                {props.shareUrl.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
          {props.shareError && <p className="mt-1 text-sm" style={{ color: "var(--bad)" }}>{props.shareError}</p>}
        </div>
      </div>

      <div className="mt-4">
        <Tabs
          tabs={[
            { value: "overview", label: "总览" },
            { value: "dims", label: "维度明细" },
            { value: "timeline", label: "问题时段" },
            { value: "lyrics", label: lyrics?.raw ? "歌词分析" : "歌词分析（未附）" },
          ]}
          selectedValue={tab}
          onValueChange={(v: string) => setTab(v)}
        />
      </div>

      {tab === "overview" && (
        <div className="mt-4 flex flex-wrap gap-6">
          <div className="grow" style={{ flexBasis: 260, minWidth: 250 }}>
            <EChart build={radarBuild} height={252} deps={[score, scene]} />
          </div>
          <div className="grid grow content-start gap-2" style={{ flexBasis: 300, minWidth: 270 }}>
            {score.findings.map((f, i) => (
              <Banner key={i} variant={toneVariant(f.tone)} title={f.text} />
            ))}
          </div>
        </div>
      )}

      {tab === "dims" && (
        <div className="mt-4 grid gap-6">
          <div className="grid gap-3">
            {rows.map((d) => (
              <div key={d.key}>
                <Meter
                  label={`${d.label} · 权重 ${d.weight}${d.lost && d.lost >= 3 ? ` · 失分 ${d.lost}` : ""}`}
                  value={d.score ?? 0}
                  customValue={d.score === null ? "不适用" : `${d.score} 分`}
                />
                <p className="mt-1 text-xs text-kumo-subtle">{d.detail}</p>
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-2">实测数值</h3>
            <Table>
              <thead>
                <tr><th>指标</th><th>数值</th></tr>
              </thead>
              <tbody>
                {metricRows.map(([k, v]) => (
                  <tr key={k}><td className="whitespace-nowrap">{k}</td><td>{v}</td></tr>
                ))}
              </tbody>
            </Table>
          </div>
          {report.pitch.hist.midi.length > 0 && (
            <div>
              <h3 className="mb-1">旋律音高分布（绿带 = 儿童舒适唱区 D4–B4）</h3>
              <EChart build={pitchBuild} height={140} deps={[report]} />
            </div>
          )}
        </div>
      )}

      {tab === "timeline" && (
        <div className="mt-4">
          <ProblemTimeline report={report} scene={scene} audioUrl={audioUrl} />
        </div>
      )}

      {tab === "lyrics" && (
        <div className="mt-4">
          <LyricsPanel {...props} />
        </div>
      )}
    </LayerCard>
  );
}

function LyricsPanel(props: ReportCardProps) {
  const { lyrics, readonly, report } = props;

  if (!lyrics?.raw) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-kumo-subtle">
          {readonly
            ? "分享者未附带歌词文件。"
            : "上传同名 .lrc 歌词文件后，可做语速、重复钩子、可接唱行的本地分析；配置 AI 端点后还可做内容审核与教育价值评估。"}
        </p>
        {!readonly && props.onAttachLrc && (
          <div>
            <label className={buttonVariants({ variant: "secondary", size: "sm" })}>
              选择 .lrc 文件
              <input type="file" accept=".lrc,text/plain" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onAttachLrc?.(f); e.target.value = ""; }} />
            </label>
          </div>
        )}
      </div>
    );
  }

  const local = lyrics.local;
  const ai = lyrics.ai;

  return (
    <div className="grid gap-6">
      {local && (
        <div>
          <h3 className="mb-2">本地文本指标（即时计算，无需 AI）</h3>
          <Table>
            <tbody>
              <tr><td>行数 / 字数</td><td>{local.lineCount} 行 / {local.charCount} 字</td></tr>
              <tr><td>语速中位</td><td>{local.medianCps ?? "—"} 字/秒{local.fastShare !== null && local.fastShare > 0 ? `（${Math.round(local.fastShare * 100)}% 的行超过 4.5 字/秒）` : ""}</td></tr>
              <tr><td>重复行占比</td><td>{Math.round(local.dupLineShare * 100)}%（副歌钩子的文本证据）</td></tr>
              <tr><td>可接唱行占比</td><td>{local.clozeReadyShare !== null ? `${Math.round(local.clozeReadyShare * 100)}%（行尾落在声学留白上）` : "无留白数据"}</td></tr>
            </tbody>
          </Table>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-kumo-subtle">逐行明细</summary>
            <div className="mt-2 overflow-y-auto" style={{ maxHeight: 260 }}>
              <Table>
                <tbody>
                  {local.perLine.slice(0, 80).map((l, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap tabular-nums">{fmtTime(l.t)}</td>
                      <td>{l.text}</td>
                      <td className="whitespace-nowrap">{l.cps} 字/s</td>
                      <td>{l.clozeReady === null ? "" : l.clozeReady ? <Badge variant="success">可接唱</Badge> : <Badge variant="neutral">无留白</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </details>
        </div>
      )}

      <div>
        <h3 className="mb-2">AI 内容分析</h3>
        {ai ? (
          <div className="grid gap-3">
            <div className="grid gap-2" style={{ maxWidth: "26rem" }}>
              <Meter label="3–6 岁适龄度" value={ai.ageFit} customValue={`${ai.ageFit} 分`} />
              <Meter label="教育价值" value={ai.eduValue} customValue={`${ai.eduValue} 分`} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={ai.safety === "ok" ? "success" : ai.safety === "warn" ? "warning" : "error"}>
                内容安全：{ai.safety === "ok" ? "通过" : ai.safety === "warn" ? "需留意" : "不通过"}
              </Badge>
              <Badge variant={ai.answersAtLineEnd === "yes" ? "success" : ai.answersAtLineEnd === "partial" ? "warning" : "error"}>
                答案在句尾：{ai.answersAtLineEnd === "yes" ? "是" : ai.answersAtLineEnd === "partial" ? "部分" : "否"}
              </Badge>
              {ai.knowledgePoints.map((k, i) => <Badge key={i} variant="blue">{k}</Badge>)}
            </div>
            {ai.summary && <p className="text-sm">{ai.summary}</p>}
            {ai.issues.length > 0 && (
              <ul className="list-none pl-4 text-sm" style={{ color: "var(--warn)" }}>
                {ai.issues.map((s, i) => <li key={i}>△ {s}</li>)}
              </ul>
            )}
            {ai.suggestions.length > 0 && (
              <ul className="list-none pl-4 text-sm">
                {ai.suggestions.map((s, i) => <li key={i}>→ {s}</li>)}
              </ul>
            )}
            <p className="text-xs text-kumo-subtle">
              模型：{ai.model} · AI 判断仅供参考，正式发布前仍需人工内容审查
            </p>
          </div>
        ) : readonly ? (
          <p className="text-sm text-kumo-subtle">分享内容未包含 AI 分析。</p>
        ) : (
          <div className="grid gap-2">
            {props.aiError && <Banner variant="error" title={props.aiError} />}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={props.onRunAI} disabled={props.aiBusy || !props.hasAIConfig}>
                {props.aiBusy ? "分析中…" : "运行 AI 分析"}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onOpenAISettings}>
                {props.hasAIConfig ? "修改 AI 配置" : "先配置 AI 端点"}
              </Button>
              <span className="text-xs text-kumo-subtle">
                Key 只存本机 localStorage，经本站中转调用、不记录不存储
              </span>
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-kumo-subtle">
        音频时长 {report.meta.durationSec}s；歌词按 LRC 时间戳与声学留白交叉验证。
      </p>
    </div>
  );
}
