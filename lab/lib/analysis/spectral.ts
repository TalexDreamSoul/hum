/**
 * 频谱指标：能量分布（清晰度带 1–4 kHz、高频 >8 kHz、低频 <60 Hz）、
 * 谱质心、人声清晰度代理（中/侧比 + 音节率代理）。
 *
 * 为什么盯 1–4 kHz：语音清晰度指数（SII / Articulation Index）里辅音信息
 * 集中在这一带；辅音听不清，词就认不出——而 hum 的接唱答案词必须被听清。
 *
 * 中/侧比原理：主流混音里人声居中（mid 通道），伴奏摊开（side）。
 * 1–4 kHz 内 mid 明显强于 side，通常意味着人声在这一带占主导、不被伴奏掩蔽。
 * 这是代理指标，不是语音识别验证，页面上如实说明。
 */

import { magSpectrum, downsample, powDb } from "./dsp.ts";

export interface SpectralResult {
  lowShare: number;      // < 60 Hz
  artShare: number;      // 1–4 kHz
  highShare: number;     // > 8 kHz
  centroidHz: number;
  /** 人声活跃帧内 1–4 kHz 的 mid/side 能量比（dB）；单声道为 null */
  midSideArtDb: number | null;
  isMono: boolean;
  /** 人声带音节率代理：清晰度带通量峰 / 秒（活跃段内） */
  syllableRate: number | null;
  vocalActiveShare: number;
  /** 清晰度带能量包络（画图用） */
  artEnv: { t: number[]; v: number[] };
}

export function measureSpectral(
  mid: Float64Array, side: Float64Array, isMono: boolean, fs: number,
): SpectralResult {
  const N = 2048, HOP = 1024;
  const frames = Math.floor((mid.length - N) / HOP);
  const binHz = fs / N;
  const bLow = Math.max(1, Math.floor(60 / binHz));
  const bArtLo = Math.floor(1000 / binHz);
  const bArtHi = Math.min(N / 2 - 1, Math.floor(4000 / binHz));
  const bHigh = Math.floor(8000 / binHz);

  let eTotal = 0, eLow = 0, eArt = 0, eHigh = 0, centNum = 0;
  const artMid = new Float64Array(frames);
  const artSide = new Float64Array(frames);
  const buf = new Float64Array(N);
  let prevArt: Float64Array | null = null;
  const artFlux = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) buf[i] = mid[f * HOP + i];
    const mm = magSpectrum(buf);
    let am = 0;
    const artBand = new Float64Array(bArtHi - bArtLo + 1);
    for (let i = 1; i < mm.length; i++) {
      const p = mm[i] * mm[i];
      eTotal += p;
      centNum += p * i * binHz;
      if (i < bLow) eLow += p;
      if (i >= bArtLo && i <= bArtHi) { eArt += p; am += p; artBand[i - bArtLo] = Math.log1p(1000 * mm[i]); }
      if (i >= bHigh) eHigh += p;
    }
    artMid[f] = am;
    if (prevArt) {
      let s = 0;
      for (let i = 0; i < artBand.length; i++) {
        const d = artBand[i] - prevArt[i];
        if (d > 0) s += d;
      }
      artFlux[f] = s;
    }
    prevArt = artBand;

    if (!isMono) {
      for (let i = 0; i < N; i++) buf[i] = side[f * HOP + i];
      const ms = magSpectrum(buf);
      let as_ = 0;
      for (let i = bArtLo; i <= bArtHi; i++) as_ += ms[i] * ms[i];
      artSide[f] = as_;
    }
  }

  // 人声活跃帧：清晰度带能量高于其 60 分位
  const sortedArt = Array.from(artMid).sort((a, b) => a - b);
  const thr = sortedArt[Math.floor(sortedArt.length * 0.6)] ?? 0;
  const active: number[] = [];
  for (let f = 0; f < frames; f++) if (artMid[f] > thr && artMid[f] > 1e-10) active.push(f);

  let midSideArtDb: number | null = null;
  if (!isMono && active.length) {
    let m = 0, s = 0;
    for (const f of active) { m += artMid[f]; s += artSide[f]; }
    midSideArtDb = Math.round((powDb(m) - powDb(Math.max(s, 1e-12))) * 10) / 10;
  }

  // 音节率代理：活跃段内清晰度带通量的峰计数 / 秒
  let syllableRate: number | null = null;
  if (active.length > 10) {
    const frameRate = fs / HOP;
    // 局部均值去除
    const win = Math.round(frameRate * 0.6);
    let peaks = 0;
    for (const f of active) {
      let sum = 0, c = 0;
      for (let j = Math.max(0, f - win); j < Math.min(frames, f + win); j++) { sum += artFlux[j]; c++; }
      const dev = artFlux[f] - sum / c;
      const isPeak = dev > 0 &&
        artFlux[f] >= (artFlux[f - 1] ?? 0) && artFlux[f] > (artFlux[f + 1] ?? 0);
      if (isPeak) peaks++;
    }
    syllableRate = Math.round((peaks / (active.length / frameRate)) * 100) / 100;
  }

  const frameRate = fs / HOP;
  const t = Array.from({ length: frames }, (_, i) => i / frameRate);
  const env = downsample(t, Array.from(artMid), 360);

  return {
    lowShare: eTotal ? Math.round((eLow / eTotal) * 1000) / 1000 : 0,
    artShare: eTotal ? Math.round((eArt / eTotal) * 1000) / 1000 : 0,
    highShare: eTotal ? Math.round((eHigh / eTotal) * 1000) / 1000 : 0,
    centroidHz: eTotal ? Math.round(centNum / eTotal) : 0,
    midSideArtDb,
    isMono,
    syllableRate,
    vocalActiveShare: frames ? Math.round((active.length / frames) * 1000) / 1000 : 0,
    artEnv: env,
  };
}
