/**
 * 重复度：0.5s 帧级 chroma 自相似。
 *
 * 为什么测重复：重复是音乐记忆的第一机制（Margulis《On Repeat》；
 * 耳虫/INMI 研究显示 90%+ 的人每周都被旋律"洗脑"）。对承载知识点的儿歌，
 * 副歌重复率直接决定钩子强度——但 100% 重复等于单调，所以评分取区间而非越高越好。
 *
 * 实现：FFT bin 折叠到 12 个音级 → 帧向量 L2 归一 → 余弦自相似，
 * 对每帧取"距它 ≥4s 的最相似帧"，其相似度 > 0.90 记为"有重复"。
 * 局限：对移调重复、变奏不敏感；这里要的是保守下界。
 */

import { magSpectrum, resampleLinear } from "./dsp.ts";

export interface RepetitionResult {
  repeatedShare: number;
  /** 每帧与远处最相似帧的相似度序列（画热条用），帧长 0.5s */
  simSeries: { t: number[]; v: number[] };
  sectionCount: number;
}

export function measureRepetition(mono: Float64Array, fs: number): RepetitionResult {
  const target = 22050;
  const x = fs > target * 1.5 ? resampleLinear(mono, fs, target) : mono;
  const xfs = fs > target * 1.5 ? target : fs;

  const N = 4096;
  const HOP = Math.round(xfs * 0.5);
  const frames = Math.floor((x.length - N) / HOP);
  if (frames < 12) return { repeatedShare: 0, simSeries: { t: [], v: [] }, sectionCount: 0 };

  const binHz = xfs / N;
  const chroma: Float64Array[] = [];
  const buf = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) buf[i] = x[f * HOP + i];
    const mag = magSpectrum(buf);
    const c = new Float64Array(12);
    const loBin = Math.max(1, Math.floor(55 / binHz));
    const hiBin = Math.min(mag.length - 1, Math.floor(4000 / binHz));
    for (let i = loBin; i <= hiBin; i++) {
      const freq = i * binHz;
      const pc = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 12 + 9) % 12; // A=9
      c[pc] += Math.log1p(1000 * mag[i]);
    }
    let norm = 0;
    for (let k = 0; k < 12; k++) norm += c[k] * c[k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < 12; k++) c[k] /= norm;
    chroma.push(c);
  }

  const MIN_SEP = 8; // ≥ 4 秒
  const best = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let m = 0;
    const ci = chroma[i];
    for (let j = 0; j < frames; j++) {
      if (Math.abs(i - j) < MIN_SEP) continue;
      const cj = chroma[j];
      let dot = 0;
      for (let k = 0; k < 12; k++) dot += ci[k] * cj[k];
      if (dot > m) m = dot;
    }
    best[i] = m;
  }

  const THR = 0.90;
  let repeated = 0;
  let sections = 0;
  let run = 0;
  for (let i = 0; i < frames; i++) {
    if (best[i] > THR) { repeated++; run++; }
    else { if (run >= 4) sections++; run = 0; }
  }
  if (run >= 4) sections++;

  return {
    repeatedShare: Math.round((repeated / frames) * 1000) / 1000,
    simSeries: {
      t: Array.from({ length: frames }, (_, i) => (i * HOP) / xfs),
      v: Array.from(best, (v) => Math.round(v * 1000) / 1000),
    },
    sectionCount: sections,
  };
}
