/**
 * 主旋律音高（F0）估计：带通 180–700 Hz 后做归一化自相关。
 * 目的不是精确转谱，而是回答一个问题：旋律有多大比例落在孩子唱得上去的音区。
 *
 * 儿童舒适唱区取 D4–B4（293.66–493.88 Hz），并给出宽带 C4–C5 作对照
 * （音乐教育研究的常用约定，页面上注明其精度边界）。
 *
 * 诚实边界：对成品混音做 F0 提取会受伴奏干扰。带通与清晰度门限
 * 能压掉大部分噪声，但结果仍是"主旋律区能量的音高倾向"，不是人声轨的真值。
 */

import { highPass, lowPass, resampleLinear, semitoneFromHz, median, percentileSorted } from "./dsp.ts";

export const BAND_COMFORT = { lo: 293.66, hi: 493.88, label: "D4–B4" };
export const BAND_WIDE = { lo: 261.63, hi: 523.25, label: "C4–C5" };

export interface PitchResult {
  voicedRatio: number;
  medianF0: number | null;
  /** P5–P95 的音域跨度（半音） */
  spanSemitones: number | null;
  shareComfort: number;
  shareWide: number;
  /** 半音直方图（C3=48 到 C6=84），画图用 */
  hist: { midi: number[]; count: number[] };
  series: { t: number[]; f0: number[] };
}

export function measurePitch(mono: Float64Array, fs: number): PitchResult {
  const target = 11025;
  const x0 = resampleLinear(mono, fs, target);
  // 带通：高通 180 + 低通 700（各二阶）
  const hp = highPass(target, 180, 0.707);
  const lp = lowPass(target, 700, 0.707);
  const x = new Float64Array(x0.length);
  hp.processInto(x0, x);
  lp.processInto(x, x);

  const FRAME = 512; // ~46ms
  const HOP = 256;
  const minLag = Math.floor(target / 600); // ≈18
  const maxLag = Math.ceil(target / 180);  // ≈61
  const frames = Math.floor((x.length - FRAME) / HOP);

  // 能量地板：全曲帧能量的 20 分位以上才参与
  const energies = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) { const v = x[f * HOP + i]; e += v * v; }
    energies[f] = e / FRAME;
  }
  const sortedE = Array.from(energies).sort((a, b) => a - b);
  const floor = percentileSorted(sortedE, 35);

  const times: number[] = [];
  const f0s: number[] = [];
  let voiced = 0, considered = 0;

  for (let f = 0; f < frames; f++) {
    if (energies[f] <= floor || energies[f] < 1e-8) continue;
    considered++;
    const off = f * HOP;
    // 归一化自相关
    let r0 = 0;
    for (let i = 0; i < FRAME; i++) r0 += x[off + i] * x[off + i];
    if (r0 <= 0) continue;
    let bestLag = -1, bestVal = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let r = 0;
      for (let i = 0; i + lag < FRAME; i++) r += x[off + i] * x[off + i + lag];
      const norm = r / r0;
      if (norm > bestVal) { bestVal = norm; bestLag = lag; }
    }
    if (bestLag > 0 && bestVal > 0.62) {
      voiced++;
      const f0 = target / bestLag;
      times.push((off + FRAME / 2) / target);
      f0s.push(f0);
    }
  }

  const voicedRatio = considered ? voiced / considered : 0;
  if (f0s.length < 12) {
    return {
      voicedRatio, medianF0: null, spanSemitones: null,
      shareComfort: 0, shareWide: 0,
      hist: { midi: [], count: [] }, series: { t: [], f0: [] },
    };
  }

  const semis = f0s.map(semitoneFromHz);
  const sortedS = [...semis].sort((a, b) => a - b);
  const span = percentileSorted(sortedS, 95) - percentileSorted(sortedS, 5);
  const inBand = (f: number, b: { lo: number; hi: number }) => f >= b.lo && f <= b.hi;
  const shareComfort = f0s.filter((f) => inBand(f, BAND_COMFORT)).length / f0s.length;
  const shareWide = f0s.filter((f) => inBand(f, BAND_WIDE)).length / f0s.length;

  // 直方图 C3(48)–C6(84)
  const midiLo = 48, midiHi = 84;
  const count = new Array(midiHi - midiLo + 1).fill(0);
  for (const s of semis) {
    const m = Math.round(s);
    if (m >= midiLo && m <= midiHi) count[m - midiLo]++;
  }

  return {
    voicedRatio: Math.round(voicedRatio * 1000) / 1000,
    medianF0: Math.round(median(f0s) * 10) / 10,
    spanSemitones: Math.round(span * 10) / 10,
    shareComfort: Math.round(shareComfort * 1000) / 1000,
    shareWide: Math.round(shareWide * 1000) / 1000,
    hist: { midi: Array.from({ length: count.length }, (_, i) => midiLo + i), count },
    series: { t: times, f0: f0s },
  };
}
