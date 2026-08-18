/**
 * 引擎冒烟测试：合成信号 → 已知答案。
 * 跑法：node test/smoke.ts   （Node 24 原生剥离 TS 类型）
 * 校验接线与量级，不校验精度极限；容差放宽。
 */

import { measureLoudness } from "../lib/analysis/loudness.ts";
import { measureTempo } from "../lib/analysis/tempo.ts";
import { measurePitch } from "../lib/analysis/pitch.ts";
import { measureRepetition } from "../lib/analysis/repetition.ts";
import { measureGaps } from "../lib/analysis/gaps.ts";

let failed = 0;
function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

const FS = 48000;

// ── 1. LUFS：997 Hz 正弦，双声道 −18 dBFS → 应约 −18.7 LUFS ──
{
  const n = FS * 8;
  const amp = Math.pow(10, -18 / 20);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * 997 * i) / FS);
  const r = measureLoudness([ch, ch.slice(0)], FS);
  check("LUFS −18dBFS 正弦 ≈ −18.7", Math.abs(r.integratedLufs + 18.7) < 0.8, `${r.integratedLufs.toFixed(2)} LUFS`);
  check("真峰值 ≈ −18 dBTP", Math.abs(r.truePeakDbtp + 18) < 0.5, `${r.truePeakDbtp.toFixed(2)} dBTP`);
}

// ── 2. 节奏：120 BPM 白噪短促脉冲 ──
{
  const dur = 20, n = FS * dur;
  const ch = new Float64Array(n);
  const period = (60 / 120) * FS;
  for (let b = 0; b * period < n; b++) {
    const off = Math.round(b * period);
    for (let i = 0; i < 1200 && off + i < n; i++) {
      ch[off + i] += (Math.sin(i * 0.9) + Math.sin(i * 2.3)) * Math.exp(-i / 260) * 0.5;
    }
  }
  const r = measureTempo(ch, FS);
  const near = (x: number | null, t: number) => x !== null && Math.abs(x - t) < 4;
  const ok = near(r.bpm, 120) || near(r.bpm, 60) || near(r.bpm, 240);
  check("节奏 120 BPM（允许倍频）", ok, `${r.bpm} BPM, salience ${r.salience}`);
}

// ── 3. 音高：330 Hz（E4）正弦 → 中位 F0 ≈ 330，舒适区占比高 ──
{
  const n = FS * 5;
  const ch = new Float64Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / FS);
  const r = measurePitch(ch, FS);
  check("F0 ≈ 330 Hz", r.medianF0 !== null && Math.abs(r.medianF0 - 330) < 12, `${r.medianF0} Hz`);
  check("E4 在舒适区（占比 > 0.8）", r.shareComfort > 0.8, `share ${r.shareComfort}`);
}

// ── 4. 重复度：2s 琶音模式重复 10 次 → repeatedShare 高 ──
{
  const pat = 2 * FS;
  const n = pat * 10;
  const ch = new Float64Array(n);
  const notes = [262, 330, 392, 523];
  for (let rep = 0; rep < 10; rep++) {
    for (let k = 0; k < 4; k++) {
      const off = rep * pat + k * (pat / 4);
      for (let i = 0; i < pat / 4; i++) {
        ch[off + i] = 0.25 * Math.sin((2 * Math.PI * notes[k] * i) / FS) * Math.exp(-i / (FS * 0.4));
      }
    }
  }
  const r = measureRepetition(ch, FS);
  check("重复模式 repeatedShare > 0.7", r.repeatedShare > 0.7, `share ${r.repeatedShare}`);
}

// ── 5. 留白：人声带 1.5s 开 / 0.8s 关，持续低频床 ──
{
  const dur = 30, n = FS * dur;
  const mid = new Float64Array(n);
  const bed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const bedV = 0.12 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 220 * t);
    bed[i] = bedV;
    const cyc = t % 2.3;
    const vocalOn = cyc < 1.5;
    const v = vocalOn ? 0.3 * Math.sin(2 * Math.PI * 440 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t)) : 0;
    mid[i] = bedV + v;
  }
  const r = measureGaps(mid, mid, FS);
  check("留白检出（>6 次/分）", r.gapsPerMin > 6, `${r.gapsPerMin} 次/分, 平均 ${r.meanGapMs} ms`);
}

console.log(failed ? `\n${failed} 项未过` : "\n全部通过");
process.exit(failed ? 1 : 0);
