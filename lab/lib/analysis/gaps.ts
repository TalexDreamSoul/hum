/**
 * 留白检测：人声休止但伴奏仍在的窗口。
 *
 * 为什么测这个：被动听会制造"学会了"的错觉，真正管用的是主动提取
 * （retrieval practice）。hum 的接唱机制需要歌里存在可供孩子接的空位——
 * 一首从头唱到尾、没有呼吸口的歌，没法做挖空。
 *
 * 实现：mid 通道带通 300–4000 Hz 求 100ms 包络（近似人声能量），
 * 全带包络作为"伴奏还在"的判据。人声包络低于其活跃中位数 −9 dB、
 * 且全带包络仍在其中位数 −6 dB 以内、持续 ≥300ms → 记一个留白。
 * 局限：没有做人声分离，乐器独奏段会被算进来；这里要的是"可挖空窗口"的上界估计。
 */

import { highPass, lowPass, ampDb, percentileSorted } from "./dsp.ts";

export interface GapsResult {
  gapsPerMin: number;
  meanGapMs: number | null;
  gapCount: number;
  /** 留白区间（秒），画时间轴用 */
  spans: { start: number; end: number }[];
  durationSec: number;
}

export function measureGaps(mid: Float64Array, monoFull: Float64Array, fs: number): GapsResult {
  // 人声带包络
  const hp = highPass(fs, 300, 0.707);
  const lp = lowPass(fs, 4000, 0.707);
  const v = new Float64Array(mid.length);
  hp.processInto(mid, v);
  lp.processInto(v, v);

  const WIN = Math.round(fs * 0.1);
  const nWin = Math.floor(mid.length / WIN);
  const vocalDb = new Float64Array(nWin);
  const bedDb = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let ev = 0, eb = 0;
    const off = w * WIN;
    for (let i = 0; i < WIN; i++) {
      ev += v[off + i] * v[off + i];
      eb += monoFull[off + i] * monoFull[off + i];
    }
    vocalDb[w] = ampDb(Math.sqrt(ev / WIN));
    bedDb[w] = ampDb(Math.sqrt(eb / WIN));
  }

  // 活跃中位数：只取人声包络的上 60%（避免前奏尾奏拉低基线）
  const sortedV = Array.from(vocalDb).sort((a, b) => a - b);
  const vMedActive = percentileSorted(sortedV, 70);
  const sortedB = Array.from(bedDb).sort((a, b) => a - b);
  const bMed = percentileSorted(sortedB, 50);

  const isGap = (w: number) => vocalDb[w] < vMedActive - 9 && bedDb[w] > bMed - 6;

  const spans: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let w = 0; w < nWin; w++) {
    if (isGap(w)) {
      if (runStart < 0) runStart = w;
    } else if (runStart >= 0) {
      const ms = (w - runStart) * 100;
      if (ms >= 300) spans.push({ start: (runStart * WIN) / fs, end: (w * WIN) / fs });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    const ms = (nWin - runStart) * 100;
    if (ms >= 300) spans.push({ start: (runStart * WIN) / fs, end: (nWin * WIN) / fs });
  }

  const durationSec = mid.length / fs;
  const durations = spans.map((s) => (s.end - s.start) * 1000);
  return {
    gapsPerMin: durationSec > 0 ? Math.round((spans.length / (durationSec / 60)) * 10) / 10 : 0,
    meanGapMs: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    gapCount: spans.length,
    spans: spans.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 })),
    durationSec: Math.round(durationSec * 10) / 10,
  };
}
