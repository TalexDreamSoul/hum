/**
 * 分析编排：解码后的 PCM → 各模块 → 评分。
 * 在主线程分段执行，段间让出事件循环保持 UI 响应
 * （3 分钟的歌全流程约 2–5 秒，无需 Web Worker 的复杂度）。
 */

import { toMono, midSide } from "./dsp.ts";
import { measureLoudness, type LoudnessResult } from "./loudness.ts";
import { measureTempo, type TempoResult } from "./tempo.ts";
import { measurePitch, type PitchResult } from "./pitch.ts";
import { measureSpectral, type SpectralResult } from "./spectral.ts";
import { measureRepetition, type RepetitionResult } from "./repetition.ts";
import { measureGaps, type GapsResult } from "./gaps.ts";
import { computeScore, type SceneKey, type ScoreReport } from "./score.ts";

export interface AnalysisReport {
  meta: { name: string; durationSec: number; sampleRate: number; channels: number };
  loudness: LoudnessResult;
  tempo: TempoResult;
  pitch: PitchResult;
  spectral: SpectralResult;
  repetition: RepetitionResult;
  gaps: GapsResult;
  score: ScoreReport;
}

export type StageKey = "loudness" | "tempo" | "pitch" | "spectral" | "repetition" | "gaps" | "score";

export const STAGE_LABELS: Record<StageKey, string> = {
  loudness: "响度（BS.1770 K 计权）",
  tempo: "节奏（起始检测 + 自相关）",
  pitch: "音高（自相关 F0）",
  spectral: "频谱与清晰度",
  repetition: "重复度（chroma 自相似）",
  gaps: "留白检测",
  score: "评分汇总",
};

const yieldUI = () => new Promise<void>((r) => setTimeout(r, 0));

export async function analyze(
  name: string,
  channels: Float32Array[],
  sampleRate: number,
  scene: SceneKey,
  onStage?: (stage: StageKey) => void,
): Promise<AnalysisReport> {
  const mono = toMono(channels);
  const { mid, side, isMono } = midSide(channels);

  onStage?.("loudness");
  await yieldUI();
  const loudness = measureLoudness(channels, sampleRate);

  onStage?.("tempo");
  await yieldUI();
  const tempo = measureTempo(mono, sampleRate);

  onStage?.("pitch");
  await yieldUI();
  const pitch = measurePitch(mid, sampleRate);

  onStage?.("spectral");
  await yieldUI();
  const spectral = measureSpectral(mid, side, isMono, sampleRate);

  onStage?.("repetition");
  await yieldUI();
  const repetition = measureRepetition(mono, sampleRate);

  onStage?.("gaps");
  await yieldUI();
  const gaps = measureGaps(mid, mono, sampleRate);

  onStage?.("score");
  await yieldUI();
  const score = computeScore(scene, loudness, tempo, pitch, spectral, repetition, gaps);

  return {
    meta: {
      name,
      durationSec: Math.round((channels[0].length / sampleRate) * 10) / 10,
      sampleRate,
      channels: channels.length,
    },
    loudness, tempo, pitch, spectral, repetition, gaps, score,
  };
}
