/**
 * 评分模型：9 个维度、权重合计 100；生产候选可用 SongSpec 覆盖场景时长目标。
 * 阈值全部集中在这个文件——评分标准即代码，页面上的解释与这里一一对应。
 */

import type { LoudnessResult } from "./loudness.ts";
import type { TempoResult } from "./tempo.ts";
import type { PitchResult } from "./pitch.ts";
import type { SpectralResult } from "./spectral.ts";
import type { RepetitionResult } from "./repetition.ts";
import type { GapsResult } from "./gaps.ts";

export type SceneKey =
  | "general"
  | "morning"
  | "commute"
  | "bath"
  | "meal"
  | "play"
  | "focus"
  | "travel"
  | "bedtime";

export interface ScenePreset {
  label: string;
  /** [硬下限, 软下限, 软上限, 硬上限] BPM */
  bpmBand: [number, number, number, number];
  bpmAnchor: number | null;
  lufsTarget: number;
  /** 产品侧的单曲目标；不是宣称所有儿童都有同一个注意时长。 */
  durTargetSec: number;
  /** 场景硬上限，超过后时长维度归零。 */
  durMaxSec: number;
  lraBand: [number, number, number, number];
}

export const SCENES: Record<SceneKey, ScenePreset> = {
  general: { label: "通用", bpmBand: [62, 84, 152, 186], bpmAnchor: null, lufsTarget: -16, durTargetSec: 90, durMaxSec: 240, lraBand: [1.5, 3, 9, 14] },
  morning: { label: "晨间", bpmBand: [96, 116, 148, 172], bpmAnchor: 132, lufsTarget: -16, durTargetSec: 60, durMaxSec: 100, lraBand: [1.5, 3, 9, 14] },
  commute: { label: "通勤", bpmBand: [88, 106, 134, 156], bpmAnchor: 120, lufsTarget: -16, durTargetSec: 90, durMaxSec: 190, lraBand: [1.5, 3, 8, 12] },
  meal:    { label: "用餐", bpmBand: [76, 92, 117, 136], bpmAnchor: 104, lufsTarget: -18, durTargetSec: 75, durMaxSec: 160, lraBand: [1.5, 3, 9, 14] },
  bath:    { label: "洗漱", bpmBand: [92, 108, 138, 160], bpmAnchor: 122, lufsTarget: -16, durTargetSec: 60, durMaxSec: 130, lraBand: [1.5, 3, 9, 14] },
  play:    { label: "玩耍", bpmBand: [104, 120, 158, 180], bpmAnchor: 138, lufsTarget: -15, durTargetSec: 90, durMaxSec: 210, lraBand: [1.5, 3, 9, 14] },
  focus:   { label: "专注复习", bpmBand: [72, 84, 112, 130], bpmAnchor: 96, lufsTarget: -18, durTargetSec: 120, durMaxSec: 300, lraBand: [1, 2, 7, 11] },
  travel:  { label: "长途出行", bpmBand: [82, 96, 130, 152], bpmAnchor: 112, lufsTarget: -16, durTargetSec: 150, durMaxSec: 300, lraBand: [1.5, 3, 9, 14] },
  bedtime: { label: "睡前", bpmBand: [56, 67, 86, 100], bpmAnchor: 76, lufsTarget: -18, durTargetSec: 120, durMaxSec: 250, lraBand: [1, 2, 7, 11] },
};

export interface DimScore {
  key: string;
  label: string;
  weight: number;
  /** null = 该维度不适用（如纯伴奏无人声），权重会被重新归一 */
  score: number | null;
  detail: string;
}

export interface Finding {
  tone: "good" | "warn" | "bad" | "info";
  text: string;
}

export interface ScoreReport {
  total: number;
  grade: "A" | "B" | "C" | "D";
  dims: DimScore[];
  findings: Finding[];
  scene: SceneKey;
}

/** 梯形带评分：软带内 100，向硬边线性降到 0。 */
export function bandScore(v: number, lo0: number, lo1: number, hi1: number, hi0: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v >= lo1 && v <= hi1) return 100;
  if (v <= lo0 || v >= hi0) return 0;
  if (v < lo1) return (100 * (v - lo0)) / (lo1 - lo0);
  return (100 * (hi0 - v)) / (hi0 - hi1);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function computeScore(
  scene: SceneKey,
  loud: LoudnessResult,
  tempo: TempoResult,
  pitch: PitchResult,
  spec: SpectralResult,
  rep: RepetitionResult,
  gaps: GapsResult,
  targetDurationSec?: number,
): ScoreReport {
  const p = SCENES[scene];
  const dims: DimScore[] = [];
  const findings: Finding[] = [];
  const hasVocal = pitch.voicedRatio >= 0.08 && pitch.medianF0 !== null;

  // ── 1 响度与安全（15）──
  {
    const t = p.lufsTarget;
    let s = bandScore(loud.integratedLufs, t - 5, t - 2.5, t + 2.5, t + 5);
    let tpNote = "";
    if (loud.truePeakDbtp > 0) { s = Math.max(0, s - 35); tpNote = `；真峰值 ${r1(loud.truePeakDbtp)} dBTP 已超 0，存在削波`; }
    else if (loud.truePeakDbtp > -1) { s = Math.max(0, s - 15); tpNote = `；真峰值 ${r1(loud.truePeakDbtp)} dBTP 高于 −1 红线`; }
    dims.push({
      key: "loudness", label: "响度与安全", weight: 14, score: Math.round(s),
      detail: `整体 ${r1(loud.integratedLufs)} LUFS（目标 ${t}±2.5）${tpNote}`,
    });
    if (Math.abs(loud.integratedLufs - t) <= 2.5 && loud.truePeakDbtp <= -1) {
      findings.push({ tone: "good", text: `响度 ${r1(loud.integratedLufs)} LUFS 落在目标带内，真峰值 ${r1(loud.truePeakDbtp)} dBTP 安全——家长设一次音量即可，整张播放列表不会忽大忽小。` });
    } else if (loud.integratedLufs > t + 2.5) {
      findings.push({ tone: "warn", text: `响度 ${r1(loud.integratedLufs)} LUFS 偏响（目标 ${t}）。儿童内容宁低勿高：WHO/ITU 对儿童的安全暴露参考是 75 dB(A)/40 小时·周。` });
    } else if (loud.integratedLufs < t - 2.5) {
      findings.push({ tone: "warn", text: `响度 ${r1(loud.integratedLufs)} LUFS 偏轻，车内噪声下家长会调大音量，列表内其他曲目就会过响。` });
    }
    if (loud.truePeakDbtp > -1) findings.push({ tone: "bad", text: `真峰值 ${r1(loud.truePeakDbtp)} dBTP 高于 −1 dBTP 红线，转码到蓝牙/AAC 时可能产生削波毛刺。` });
  }

  // ── 2 动态起伏（8）──
  {
    const [a, b, c, d] = p.lraBand;
    const s = bandScore(loud.lra, a, b, c, d);
    dims.push({
      key: "dynamics", label: "动态起伏", weight: 7, score: Math.round(s),
      detail: `LRA ${r1(loud.lra)} LU（目标 ${b}–${c}）`,
    });
    if (loud.lra < b) findings.push({ tone: "warn", text: `动态范围 ${r1(loud.lra)} LU 偏平，从头到尾一堵墙的声音容易听觉疲劳。` });
    if (loud.lra > c) findings.push({ tone: "warn", text: `动态范围 ${r1(loud.lra)} LU 偏大，安静段在车内噪声（约 65–70 dB）里会听不见。` });
  }

  // ── 3 节奏适配（14）──
  {
    let s: number | null = null;
    let detail = "未检出稳定节奏";
    if (tempo.bpm) {
      const [a, b, c, d] = p.bpmBand;
      const candidates = [tempo.bpm, tempo.bpm * 2, tempo.bpm / 2];
      const scores = candidates.map((v) => bandScore(v, a, b, c, d));
      let best = Math.max(...scores);
      const bestIdx = scores.indexOf(best);
      if (bestIdx > 0 && best > 0) best = Math.max(0, best - 5); // 倍频修正的轻惩罚
      if (tempo.salience < 1.2) best = Math.min(best, 70);
      s = Math.round(best);
      const shown = r1(candidates[bestIdx]);
      detail = `${r1(tempo.bpm)} BPM${bestIdx > 0 ? `（按 ${shown} 计）` : ""}，场景带 ${b}–${c}${tempo.salience < 1.2 ? "；节奏峰不显著，估计置信度低" : ""}`;
      if (best >= 90) findings.push({ tone: "good", text: `节奏 ${shown} BPM 落在${p.label}场景带（${b}–${c}）。学龄前儿童自发运动节奏约 150 BPM，越接近场景锚点越容易跟拍跟唱。` });
      else if (best < 60) findings.push({ tone: "warn", text: `节奏 ${shown} BPM 偏离${p.label}场景带（${b}–${c}），跟唱与场景氛围都吃亏。` });
    }
    dims.push({ key: "tempo", label: "节奏适配", weight: 13, score: s, detail });
  }

  // ── 4 适唱音域（15）──
  {
    let s: number | null = null;
    let detail = "未检出人声（可能是纯伴奏）";
    if (hasVocal) {
      let v = Math.max(0, Math.min(100, ((pitch.shareComfort - 0.30) / (0.60 - 0.30)) * 100));
      if (pitch.spanSemitones !== null && pitch.spanSemitones > 12) {
        v = Math.max(0, v - Math.min(30, (pitch.spanSemitones - 12) * 4));
      }
      s = Math.round(v);
      detail = `舒适区 D4–B4 占比 ${Math.round(pitch.shareComfort * 100)}%，音域跨度 ${pitch.spanSemitones} 半音，中位 ${pitch.medianF0} Hz`;
      if (pitch.shareComfort >= 0.6) findings.push({ tone: "good", text: `旋律 ${Math.round(pitch.shareComfort * 100)}% 的时间落在儿童舒适唱区 D4–B4——孩子够得着，才接得上。` });
      else if (pitch.shareComfort < 0.35) findings.push({ tone: "bad", text: `旋律只有 ${Math.round(pitch.shareComfort * 100)}% 落在 D4–B4 舒适唱区，孩子生理上唱不上去/唱不下来，接唱机制会失效。` });
      if ((pitch.spanSemitones ?? 0) > 12) findings.push({ tone: "warn", text: `音域跨度 ${pitch.spanSemitones} 半音，超过一个八度，对 3–6 岁偏难。` });
    }
    dims.push({ key: "range", label: "适唱音域", weight: 14, score: s, detail });
  }

  // ── 5 人声清晰度（代理）（14）──
  {
    let s: number | null = null;
    let detail = "未检出人声";
    if (hasVocal) {
      const s1 = bandScore(spec.artShare, 0.08, 0.15, 0.45, 0.60);
      let s2 = 85; // 单声道：无法测中/侧，按中性偏好处理
      if (spec.midSideArtDb !== null) {
        s2 = spec.midSideArtDb >= 8 ? 100 : spec.midSideArtDb >= 3 ? 60 + ((spec.midSideArtDb - 3) / 5) * 40 : Math.max(0, (spec.midSideArtDb / 3) * 60);
      }
      const s3 = spec.syllableRate !== null ? bandScore(spec.syllableRate, 0.8, 1.5, 4.2, 5.5) : 70;
      s = Math.round(0.4 * s1 + 0.3 * s2 + 0.3 * s3);
      detail = `1–4 kHz 占比 ${Math.round(spec.artShare * 100)}%` +
        (spec.midSideArtDb !== null ? `，中/侧 ${spec.midSideArtDb} dB` : "（单声道）") +
        (spec.syllableRate !== null ? `，音节率代理 ${spec.syllableRate}/s` : "");
      if (spec.midSideArtDb !== null && spec.midSideArtDb < 3) {
        findings.push({ tone: "warn", text: `清晰度带内人声对伴奏的优势只有 ${spec.midSideArtDb} dB，答案词有被伴奏掩蔽的风险——辅音信息集中在 1–4 kHz，这一带被盖住，词就听不清。` });
      }
      if (spec.syllableRate !== null && spec.syllableRate > 4.5) {
        findings.push({ tone: "warn", text: `音节率代理 ${spec.syllableRate}/s 偏快，低龄儿童跟不上词。` });
      }
    }
    dims.push({ key: "clarity", label: "人声清晰度", weight: 13, score: s, detail });
  }

  // ── 6 重复与结构（14）──
  {
    const s = Math.round(bandScore(rep.repeatedShare, 0.12, 0.32, 0.72, 0.88));
    dims.push({
      key: "repetition", label: "重复与结构", weight: 13, score: s,
      detail: `重复帧占比 ${Math.round(rep.repeatedShare * 100)}%（目标 32–72%），重复段 ${rep.sectionCount} 处`,
    });
    if (rep.repeatedShare >= 0.32 && rep.repeatedShare <= 0.72) {
      findings.push({ tone: "good", text: `重复率 ${Math.round(rep.repeatedShare * 100)}% 落在记忆友好区间——重复是旋律进脑子的第一机制，也是知识点的钩子。` });
    } else if (rep.repeatedShare < 0.32) {
      findings.push({ tone: "warn", text: `重复率只有 ${Math.round(rep.repeatedShare * 100)}%，缺少能"洗脑"的钩子，知识点没有锚。` });
    } else {
      findings.push({ tone: "warn", text: `重复率 ${Math.round(rep.repeatedShare * 100)}% 过高，接近单曲循环式单调，新信息容量太小。` });
    }
  }

  // ── 7 留白接唱（12）──
  {
    let s: number | null = null;
    let detail = "未检出人声";
    if (hasVocal) {
      const g1 = bandScore(gaps.gapsPerMin, 0.5, 2.5, 9, 15);
      const g2 = gaps.meanGapMs !== null ? bandScore(gaps.meanGapMs, 250, 400, 1600, 2600) : 40;
      s = Math.round(0.6 * g1 + 0.4 * g2);
      detail = `留白 ${gaps.gapsPerMin} 次/分，平均 ${gaps.meanGapMs ?? "—"} ms`;
      if (gaps.gapsPerMin < 2.5) {
        findings.push({ tone: "warn", text: `人声几乎不停（留白 ${gaps.gapsPerMin} 次/分）。没有呼吸口的歌做不了挖空接唱——孩子没有接的位置。` });
      } else if (gaps.gapsPerMin <= 9) {
        findings.push({ tone: "good", text: `每分钟 ${gaps.gapsPerMin} 处留白、平均 ${gaps.meanGapMs} ms——有天然的接唱位，可直接做挖空版本。` });
      }
    }
    dims.push({ key: "gaps", label: "留白接唱", weight: 11, score: s, detail });
  }

  // ── 8 频谱舒适度（8）──
  {
    const s1 = bandScore(spec.highShare, -1, 0, 0.07, 0.15);
    const s2 = bandScore(spec.lowShare, -1, 0, 0.12, 0.22);
    const s = Math.round(0.6 * s1 + 0.4 * s2);
    dims.push({
      key: "spectral", label: "频谱舒适度", weight: 7, score: s,
      detail: `>8 kHz 占 ${Math.round(spec.highShare * 100)}%，<60 Hz 占 ${Math.round(spec.lowShare * 100)}%，质心 ${spec.centroidHz} Hz`,
    });
    if (spec.highShare > 0.07) findings.push({ tone: "warn", text: `高频（>8 kHz）能量占 ${Math.round(spec.highShare * 100)}%，齿音/毛刺偏多，儿童对高频更敏感，久听易疲劳。` });
    if (spec.lowShare > 0.12) findings.push({ tone: "warn", text: `超低频（<60 Hz）占 ${Math.round(spec.lowShare * 100)}%，小音箱放不出来还挤占动态余量。` });
  }

  // ── 9 时长适配（8）──
  {
    const observed = gaps.durationSec;
    const target = targetDurationSec ?? p.durTargetSec;
    const hardMin = Math.max(10, Math.round(target * 0.5));
    const softMin = Math.max(hardMin, Math.round(target * 0.8));
    const softMax = Math.min(p.durMaxSec, Math.round(target * 1.2));
    const hardMax = Math.max(softMax, Math.min(p.durMaxSec, Math.round(target * 1.6)));
    const score = Math.round(bandScore(observed, hardMin, softMin, softMax, hardMax));
    const targetSource = targetDurationSec ? "SongSpec" : `${p.label}场景`;
    dims.push({
      key: "duration", label: "时长适配", weight: 8, score,
      detail: `实际 ${Math.round(observed)}s；${targetSource}目标 ${target}s，适配带 ${softMin}–${softMax}s，硬上限 ${hardMax}s`,
    });
    if (observed >= softMin && observed <= softMax) {
      findings.push({ tone: "good", text: `时长 ${Math.round(observed)}s 落在当前目标带 ${softMin}–${softMax}s，适合重复播放；这个区间是产品生产目标，不等同于所有儿童的普适偏好。` });
    } else if (observed > hardMax) {
      findings.push({ tone: "warn", text: `时长 ${Math.round(observed)}s 超过当前硬上限 ${hardMax}s，知识密度和重复成本偏高，建议拆成更短的单知识点版本。` });
    } else if (observed < hardMin) {
      findings.push({ tone: "warn", text: `时长只有 ${Math.round(observed)}s，低于当前下限 ${hardMin}s，可能不足以完成知识陈述、回忆钩子和一次复现。` });
    } else {
      findings.push({ tone: "info", text: `时长 ${Math.round(observed)}s 位于可接受边缘，后续应结合完播率、主动重播和 24 小时记忆结果校准。` });
    }
  }

  if (!hasVocal) {
    findings.push({ tone: "info", text: "未检出稳定人声（可能是纯伴奏/接唱版）：音域、清晰度、留白三个维度不参与计分，权重已重新归一。" });
  }

  // ── 汇总（null 维度剔除后按权重归一）──
  const valid = dims.filter((d) => d.score !== null);
  const wSum = valid.reduce((a, d) => a + d.weight, 0);
  const raw = valid.reduce((a, d) => a + (d.score as number) * d.weight, 0) / (wSum || 1);
  const total = Math.max(0, Math.round(raw));
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : "D";

  return { total, grade, dims, findings, scene };
}
