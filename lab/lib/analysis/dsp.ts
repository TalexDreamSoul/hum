/**
 * 基础 DSP：FFT、窗、双二阶滤波器、重采样、声道工具。
 * 全部纯函数/小类，便于在浏览器主线程分段执行。
 */

export const EPS = 1e-12;

export const powDb = (v: number) => 10 * Math.log10(Math.max(v, EPS));
export const ampDb = (v: number) => 20 * Math.log10(Math.max(v, EPS));

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    hannCache.set(n, w);
  }
  return w;
}

/** 迭代式 radix-2 FFT，就地计算。re/im 长度必须是 2 的幂。 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** 幅度谱（前 n/2 bin）。输入帧会先加 Hann 窗。 */
export function magSpectrum(frame: Float64Array): Float64Array {
  const n = frame.length;
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  fft(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** 双二阶滤波器（直接 II 型转置），系数已按 a0 归一。 */
export class Biquad {
  private z1 = 0;
  private z2 = 0;
  b0: number; b1: number; b2: number; a1: number; a2: number;
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
  }
  processInto(x: Float32Array | Float64Array, out: Float64Array): void {
    let z1 = this.z1, z2 = this.z2;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = b0 * xi + z1;
      z1 = b1 * xi - a1 * y + z2;
      z2 = b2 * xi - a2 * y;
      out[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }
}

/** RBJ 高架滤波（BS.1770 K 计权第一级用）。 */
export function highShelf(fs: number, f0: number, gainDb: number, Q: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const sqA2a = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 + (A - 1) * cw + sqA2a);
  const b1 = -2 * A * (A - 1 + (A + 1) * cw);
  const b2 = A * (A + 1 + (A - 1) * cw - sqA2a);
  const a0 = A + 1 - (A - 1) * cw + sqA2a;
  const a1 = 2 * (A - 1 - (A + 1) * cw);
  const a2 = A + 1 - (A - 1) * cw - sqA2a;
  return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

/** RBJ 高通（K 计权第二级 / 通用）。 */
export function highPass(fs: number, f0: number, Q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

/** RBJ 低通。 */
export function lowPass(fs: number, f0: number, Q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const b1 = 1 - cw;
  const b0 = b1 / 2, b2 = b1 / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

export function toMono(channels: Float32Array[]): Float64Array {
  const n = channels[0].length;
  const out = new Float64Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

export function midSide(channels: Float32Array[]): { mid: Float64Array; side: Float64Array; isMono: boolean } {
  const n = channels[0].length;
  const mid = new Float64Array(n);
  const side = new Float64Array(n);
  if (channels.length < 2) {
    for (let i = 0; i < n; i++) mid[i] = channels[0][i];
    return { mid, side, isMono: true };
  }
  const l = channels[0], r = channels[1];
  for (let i = 0; i < n; i++) {
    mid[i] = (l[i] + r[i]) / 2;
    side[i] = (l[i] - r[i]) / 2;
  }
  return { mid, side, isMono: false };
}

/** 线性插值重采样（分析用途足够；文档中标注为近似）。 */
export function resampleLinear(x: Float64Array, fromRate: number, toRate: number): Float64Array {
  if (fromRate === toRate) return x;
  const n = Math.floor((x.length * toRate) / fromRate);
  const out = new Float64Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function percentileSorted(sorted: number[] | Float64Array, p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const idx = Math.min(n - 1, Math.max(0, (p / 100) * (n - 1)));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const arr = sorted as ArrayLike<number>;
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return percentileSorted(s, 50);
}

/** 把长序列均匀抽样到 ≤maxPoints 个点（画图用）。 */
export function downsample(t: number[], v: number[], maxPoints: number): { t: number[]; v: number[] } {
  if (t.length <= maxPoints) return { t, v };
  const step = t.length / maxPoints;
  const ot: number[] = [], ov: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const j = Math.min(t.length - 1, Math.round(i * step));
    ot.push(t[j]); ov.push(v[j]);
  }
  return { t: ot, v: ov };
}

export const semitoneFromHz = (f: number) => 69 + 12 * Math.log2(f / 440);
export const hzFromSemitone = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
