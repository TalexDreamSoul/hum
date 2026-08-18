/**
 * 节奏估计：谱通量起始检测 + 自相关，60–200 BPM 搜索，带轻先验消除倍频歧义。
 * 学龄前儿童的自发运动节奏（SMT）约 150 BPM，跟唱最容易的区间在其附近；
 * 但 hum 的场景锚点（晨间 132 / 通勤 120 / 用餐 104 / 睡前 76）才是评分基准。
 */

import { magSpectrum, resampleLinear, downsample } from "./dsp.ts";

export interface TempoResult {
  bpm: number | null;
  /** 峰值显著度（peak-mean)/std，< 1.2 视为节奏不明确 */
  salience: number;
  altBpm: number[];
  onsetEnv: { t: number[]; v: number[] };
  frameRate: number;
}

export function measureTempo(mono: Float64Array, fs: number): TempoResult {
  // 降采样到 ~22050，够用且省时
  const target = 22050;
  const x = fs > target * 1.5 ? resampleLinear(mono, fs, target) : mono;
  const xfs = fs > target * 1.5 ? target : fs;

  const N = 1024, HOP = 512;
  const frameRate = xfs / HOP;
  const frames = Math.floor((x.length - N) / HOP);
  if (frames < 20) {
    return { bpm: null, salience: 0, altBpm: [], onsetEnv: { t: [], v: [] }, frameRate };
  }

  // 谱通量（log 压缩，半波整流）
  let prev: Float64Array | null = null;
  const flux = new Float64Array(frames);
  const buf = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) buf[i] = x[f * HOP + i];
    const mag = magSpectrum(buf);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.log1p(1000 * mag[i]);
    if (prev) {
      let s = 0;
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) s += d;
      }
      flux[f] = s;
    }
    prev = mag;
  }

  // 去局部均值（1s 窗）+ 半波整流 → 起始包络
  const win = Math.round(frameRate);
  const env = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - win); j < Math.min(frames, i + win); j++) { s += flux[j]; c++; }
    const v = flux[i] - s / c;
    env[i] = v > 0 ? v : 0;
  }

  // 自相关：BPM 50–200
  const minLag = Math.max(2, Math.floor((60 * frameRate) / 200));
  const maxLag = Math.min(frames - 2, Math.ceil((60 * frameRate) / 50));
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (frames - lag);
  }
  // 轻先验：以 120 BPM 为中心的对数正态权重，σ 取宽（0.9 oct），只用来在近似平台间选边
  const prior = (bpm: number) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));

  let bestLag = -1, bestScore = -Infinity;
  const vals: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    vals.push(ac[lag]);
    const bpm = (60 * frameRate) / lag;
    const score = ac[lag] * prior(bpm);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const salience = bestLag > 0 ? (ac[bestLag] - mean) / sd : 0;

  let bpm: number | null = null;
  const alts: number[] = [];
  if (bestLag > 0) {
    // 抛物线插值细化
    const y0 = ac[bestLag - 1] ?? ac[bestLag];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1] ?? ac[bestLag];
    const denom = y0 - 2 * y1 + y2;
    const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
    bpm = (60 * frameRate) / lag;
    for (const m of [0.5, 2]) {
      const a = bpm * m;
      if (a >= 50 && a <= 220) alts.push(Math.round(a * 10) / 10);
    }
  }

  const t = Array.from({ length: frames }, (_, i) => i / frameRate);
  const ds = downsample(t, Array.from(env), 360);

  return {
    bpm: bpm ? Math.round(bpm * 10) / 10 : null,
    salience: Math.round(salience * 100) / 100,
    altBpm: alts,
    onsetEnv: ds,
    frameRate,
  };
}
