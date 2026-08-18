/**
 * 响度测量：ITU-R BS.1770 K 计权 + 门限积分响度，EBU R128/Tech 3342 的 LRA，真峰值近似。
 *
 * K 计权用两级双二阶实现，滤波器参数取自 BS.1770 的模拟原型
 * （与 pyloudnorm 等实现一致），可适配任意采样率：
 *   一级：高架 +3.99984 dB @ 1681.97 Hz, Q 0.70718
 *   二级：高通 @ 38.1355 Hz, Q 0.50033
 *
 * 真峰值：4 倍过采样（Catmull-Rom 插值）近似，误差约 ±0.3 dB，页面上明示。
 */

import { Biquad, highShelf, highPass, powDb, percentileSorted } from "./dsp.ts";

export interface LoudnessResult {
  integratedLufs: number;
  lra: number;
  truePeakDbtp: number;
  momentaryMaxLufs: number;
  /** 短期响度（3s 窗、1s 步进）时间序列，画图用 */
  shortTerm: { t: number[]; lufs: number[] };
}

function kWeight(ch: Float32Array, fs: number): Float64Array {
  const out = new Float64Array(ch.length);
  const shelf: Biquad = highShelf(fs, 1681.9744509555319, 3.99984385397, 0.7071752369554193);
  const hp: Biquad = highPass(fs, 38.13547087613982, 0.5003270373253953);
  shelf.processInto(ch, out);
  hp.processInto(out, out);
  return out;
}

export function measureLoudness(channels: Float32Array[], fs: number): LoudnessResult {
  const weighted = channels.map((c) => kWeight(c, fs));
  const n = weighted[0].length;

  // —— 分块能量（400ms 窗、100ms 步进；G_i = 1 对 L/R）——
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const blockPow: number[] = [];
  // 前缀和加速
  const prefix = weighted.map((w) => {
    const p = new Float64Array(w.length + 1);
    for (let i = 0; i < w.length; i++) p[i + 1] = p[i] + w[i] * w[i];
    return p;
  });
  const sumSq = (p: Float64Array, a: number, b: number) => p[b] - p[a];

  for (let start = 0; start + block <= n; start += hop) {
    let z = 0;
    for (const p of prefix) z += sumSq(p, start, start + block) / block;
    blockPow.push(z);
  }
  const blockLufs = blockPow.map((z) => -0.691 + powDb(z));

  // —— 门限积分（绝对 -70，相对 -10）——
  const absPass = blockPow.filter((_, i) => blockLufs[i] > -70);
  let integrated = -Infinity;
  if (absPass.length) {
    const meanAbs = absPass.reduce((a, b) => a + b, 0) / absPass.length;
    const relGate = -0.691 + powDb(meanAbs) - 10;
    const relPass = blockPow.filter((_, i) => blockLufs[i] > -70 && blockLufs[i] > relGate);
    if (relPass.length) {
      const meanRel = relPass.reduce((a, b) => a + b, 0) / relPass.length;
      integrated = -0.691 + powDb(meanRel);
    }
  }

  // —— 短期响度（3s / 1s）与 LRA（EBU Tech 3342：绝对 -70，相对 -20，P95−P10）——
  const stBlock = Math.round(3 * fs);
  const stHop = Math.round(1 * fs);
  const stT: number[] = [];
  const stL: number[] = [];
  const stPow: number[] = [];
  for (let start = 0; start + stBlock <= n; start += stHop) {
    let z = 0;
    for (const p of prefix) z += sumSq(p, start, start + stBlock) / stBlock;
    stPow.push(z);
    stT.push((start + stBlock / 2) / fs);
    stL.push(-0.691 + powDb(z));
  }
  let lra = 0;
  {
    const absIdx = stL.map((l, i) => (l > -70 ? i : -1)).filter((i) => i >= 0);
    if (absIdx.length >= 2) {
      const meanAbs = absIdx.reduce((a, i) => a + stPow[i], 0) / absIdx.length;
      const relGate = -0.691 + powDb(meanAbs) - 20;
      const gated = absIdx.map((i) => stL[i]).filter((l) => l > relGate).sort((a, b) => a - b);
      if (gated.length >= 2) lra = percentileSorted(gated, 95) - percentileSorted(gated, 10);
    }
  }

  // —— 真峰值（4x Catmull-Rom 过采样近似）——
  let tp = 0;
  for (const ch of channels) {
    const m = ch.length;
    for (let i = 0; i < m; i++) {
      const p0 = ch[i - 1] ?? ch[i];
      const p1 = ch[i];
      const p2 = ch[i + 1] ?? ch[i];
      const p3 = ch[i + 2] ?? p2;
      const a0 = Math.abs(p1);
      if (a0 > tp) tp = a0;
      for (const t of [0.25, 0.5, 0.75]) {
        const t2 = t * t, t3 = t2 * t;
        const v =
          0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
        const av = Math.abs(v);
        if (av > tp) tp = av;
      }
    }
  }

  return {
    integratedLufs: integrated,
    lra,
    truePeakDbtp: 20 * Math.log10(Math.max(tp, 1e-12)),
    momentaryMaxLufs: blockLufs.length ? Math.max(...blockLufs) : -Infinity,
    shortTerm: { t: stT, lufs: stL },
  };
}
