/**
 * 从分析结果反推"哪些时段在扣分"——问题时段是评分的可视化对偶。
 * 三类有逐时刻数据支撑的维度：响度越界、音域越界、长段无留白。
 * （节奏/重复/频谱是全曲统计量，没有可归因的时段，不在此列——页面如实说明。）
 */

import type { AnalysisReport } from "./engine.ts";
import { SCENES, type SceneKey } from "./score.ts";
import { BAND_COMFORT } from "./pitch.ts";

export type ProblemDim = "loudness" | "range" | "nogap";

export interface ProblemSpan {
  dim: ProblemDim;
  start: number;
  end: number;
  note: string;
}

export const PROBLEM_LABELS: Record<ProblemDim, string> = {
  loudness: "响度越界",
  range: "音域越界",
  nogap: "无留白段",
};

interface Pt { t: number; bad: boolean; note?: string }

function mergeSpans(pts: Pt[], maxGap: number, minLen: number, note: (seg: Pt[]) => string): { start: number; end: number; note: string }[] {
  const out: { start: number; end: number; note: string }[] = [];
  let seg: Pt[] = [];
  const flush = () => {
    if (seg.length) {
      const start = seg[0].t, end = seg[seg.length - 1].t;
      if (end - start >= minLen) out.push({ start, end, note: note(seg) });
      seg = [];
    }
  };
  for (const p of pts) {
    if (!p.bad) { flush(); continue; }
    if (seg.length && p.t - seg[seg.length - 1].t > maxGap) flush();
    seg.push(p);
  }
  flush();
  return out;
}

export function deriveProblems(report: AnalysisReport, scene: SceneKey): ProblemSpan[] {
  const out: ProblemSpan[] = [];
  const preset = SCENES[scene];
  const dur = report.gaps.durationSec;

  // —— 响度：短期响度出目标带 ±2.5 ——
  {
    const { t, lufs } = report.loudness.shortTerm;
    const target = preset.lufsTarget;
    const pts: Pt[] = t.map((tt, i) => ({ t: tt, bad: Math.abs(lufs[i] - target) > 2.5 && lufs[i] > -55 }));
    for (const s of mergeSpans(pts, 2.2, 2.5, (seg) => {
      const vals = seg.map((p) => lufs[t.indexOf(p.t)]).filter(Number.isFinite);
      const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      return mean > target ? `偏响约 ${Math.round(mean - target)} LU` : `偏轻约 ${Math.round(target - mean)} LU`;
    })) out.push({ dim: "loudness", ...s });
  }

  // —— 音域：F0 出 D4–B4 舒适带 ——
  {
    const { t, f0 } = report.pitch.series;
    if (t.length) {
      const pts: Pt[] = t.map((tt, i) => ({ t: tt, bad: f0[i] < BAND_COMFORT.lo || f0[i] > BAND_COMFORT.hi }));
      for (const s of mergeSpans(pts, 0.7, 1.0, (seg) => {
        const vals = seg.map((p) => f0[t.indexOf(p.t)]);
        const high = vals.filter((v) => v > BAND_COMFORT.hi).length >= vals.length / 2;
        return high ? "旋律偏高，孩子够不着" : "旋律偏低，孩子沉不下去";
      })) out.push({ dim: "range", ...s });
    }
  }

  // —— 留白：留白区间在时间轴上的补集里，长度超过 25s 的段 ——
  {
    if (report.pitch.voicedRatio >= 0.08 && dur > 0) {
      let cursor = 0;
      const sorted = [...report.gaps.spans].sort((a, b) => a.start - b.start);
      const push = (a: number, b: number) => {
        if (b - a > 25) out.push({ dim: "nogap", start: a, end: b, note: `连续 ${Math.round(b - a)}s 无可接唱留白` });
      };
      for (const g of sorted) {
        push(cursor, g.start);
        cursor = Math.max(cursor, g.end);
      }
      push(cursor, dur);
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
