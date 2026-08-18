/**
 * 提示词医生：ReportCard 没过门槛时，按维度给出下一轮的具体改法。
 *
 * 规则是确定性的（不再问一次 AI）：同样的分数永远得到同样的建议，
 * 建议同时给中英两版——中文给运营看，英文直接拼进模型提示词。
 */

import { SCENES, type SceneKey } from "./analysis/score.ts";

export interface DoctorDim {
  key: string;
  score: number | null;
  detail: string;
}

export interface DoctorInput {
  scene: SceneKey;
  total: number | null;
  threshold: number;
  dims: DoctorDim[];
  music: {
    bpm: number;
    lowestNote: string;
    highestNote: string;
    positiveStyle: string[];
    negativeStyle: string[];
  };
  /** 当前知识点数量，重复度过高时用来判断要不要加内容 */
  pointCount: number;
}

export interface DoctorFix {
  dim: string;
  zh: string;
  en: string;
}

export interface DoctorPlan {
  /** 低于这个分数的维度才会被开药 */
  weakDims: string[];
  fixes: DoctorFix[];
  /** 下一轮建议直接套用的音乐参数 */
  music: {
    bpm: number;
    lowestNote: string;
    highestNote: string;
    positiveStyle: string[];
    negativeStyle: string[];
  };
  /** 没有可改的了 */
  exhausted: boolean;
}

const WEAK = 70;

const NOTE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteToSemitone(note: string): number | null {
  const match = note.trim().match(/^([A-G]#?)(\d)$/i);
  if (!match) return null;
  const index = NOTE_ORDER.indexOf(match[1].toUpperCase());
  if (index < 0) return null;
  return index + Number(match[2]) * 12;
}

function semitoneToNote(value: number): string {
  const octave = Math.floor(value / 12);
  return `${NOTE_ORDER[((value % 12) + 12) % 12]}${octave}`;
}

/** 音域压到一个八度以内，中心不动。 */
function narrowRange(lowest: string, highest: string): { lowest: string; highest: string } {
  const low = noteToSemitone(lowest);
  const high = noteToSemitone(highest);
  if (low === null || high === null || high - low <= 12) return { lowest, highest };
  const center = Math.round((low + high) / 2);
  return { lowest: semitoneToNote(center - 5), highest: semitoneToNote(center + 5) };
}

function addTags(list: string[], tags: string[]): string[] {
  const next = [...list];
  tags.forEach((tag) => { if (!next.includes(tag)) next.push(tag); });
  return next.slice(0, 40);
}

export function diagnose(input: DoctorInput): DoctorPlan {
  const byKey = new Map(input.dims.map((dim) => [dim.key, dim]));
  const weak = input.dims.filter((dim) => dim.score !== null && dim.score < WEAK);
  const fixes: DoctorFix[] = [];
  let { bpm, lowestNote, highestNote } = input.music;
  let positiveStyle = [...input.music.positiveStyle];
  let negativeStyle = [...input.music.negativeStyle];

  const scene = SCENES[input.scene];

  if ((byKey.get("loudness")?.score ?? 100) < WEAK) {
    positiveStyle = addTags(positiveStyle, ["clean mastering with 1 dB headroom", "no clipping", "gentle limiter"]);
    negativeStyle = addTags(negativeStyle, ["loudness war mastering", "heavy compression"]);
    fixes.push({
      dim: "响度与安全",
      zh: "真峰值顶到 0 dBTP 以上，转码会削波：要求留 1 dB 余量、关掉激进限幅。",
      en: "Master with at least 1 dB true-peak headroom, no clipping, no aggressive limiting.",
    });
  }

  const tempo = byKey.get("tempo");
  if ((tempo?.score ?? 100) < WEAK) {
    const anchor = scene.bpmAnchor ?? Math.round((scene.bpmBand[1] + scene.bpmBand[2]) / 2);
    bpm = anchor;
    positiveStyle = addTags(positiveStyle, [`strict ${anchor} BPM`, "steady metronomic beat", "clear downbeat"]);
    negativeStyle = addTags(negativeStyle, ["tempo drift", "rubato"]);
    fixes.push({
      dim: "节奏适配",
      zh: `节奏掉出「${scene.label}」场景带（${scene.bpmBand[1]}–${scene.bpmBand[2]}），下一轮锁到 ${anchor} BPM 并强调稳定节拍。`,
      en: `Lock the tempo to ${anchor} BPM with a steady, clearly marked beat; stay inside ${scene.bpmBand[1]}-${scene.bpmBand[2]} BPM.`,
    });
  }

  if ((byKey.get("range")?.score ?? 100) < WEAK) {
    const narrowed = narrowRange(lowestNote, highestNote);
    lowestNote = narrowed.lowest;
    highestNote = narrowed.highest;
    positiveStyle = addTags(positiveStyle, [`melody strictly within ${lowestNote}-${highestNote}`, "stepwise melodic motion"]);
    negativeStyle = addTags(negativeStyle, ["wide leaps", "high belting", "octave jumps"]);
    fixes.push({
      dim: "适唱音域",
      zh: `音域超过一个八度，孩子跟不上：压到 ${lowestNote}–${highestNote}，旋律以级进为主、少大跳。`,
      en: `Keep the whole melody inside ${lowestNote}-${highestNote}, mostly stepwise, avoid wide leaps.`,
    });
  }

  if ((byKey.get("clarity")?.score ?? 100) < WEAK) {
    positiveStyle = addTags(positiveStyle, ["vocal forward mix", "sparse arrangement", "crisp consonants"]);
    negativeStyle = addTags(negativeStyle, ["dense arrangement", "loud pads", "heavy reverb on vocal"]);
    fixes.push({
      dim: "人声清晰度",
      zh: "词被伴奏盖住了：人声推前、伴奏减薄、少混响，辅音要清楚。",
      en: "Push the vocal forward, thin out the backing, keep reverb low so consonants stay intelligible.",
    });
  }

  const repetition = byKey.get("repetition");
  if ((repetition?.score ?? 100) < WEAK) {
    positiveStyle = addTags(positiveStyle, ["contrasting bridge", "verse melody variation", "clear verse-chorus contrast"]);
    negativeStyle = addTags(negativeStyle, ["loop-like repetition", "identical verses"]);
    fixes.push({
      dim: "重复与结构",
      zh: input.pointCount < 5
        ? `整首几乎在循环同一段：先把知识点补到 5–6 条（现在 ${input.pointCount} 条），再要求主歌旋律有变化、加一段对比桥段。`
        : "整首几乎在循环同一段：要求主歌旋律逐段变化，并加一段对比桥段。",
      en: "Avoid loop-like repetition: vary the verse melody between sections and add a contrasting bridge.",
    });
  }

  if ((byKey.get("gaps")?.score ?? 100) < WEAK) {
    positiveStyle = addTags(positiveStyle, ["half-beat rest after each answer word", "call and response phrasing"]);
    fixes.push({
      dim: "留白接唱",
      zh: "句尾没有留白，孩子接不上：每个答案词唱完停半拍，做成一问一答。",
      en: "Leave a half-beat rest after every answer word so a child can sing it back; use call-and-response phrasing.",
    });
  }

  if ((byKey.get("spectral")?.score ?? 100) < WEAK) {
    negativeStyle = addTags(negativeStyle, ["harsh high frequencies", "boomy bass"]);
    positiveStyle = addTags(positiveStyle, ["warm balanced tone"]);
    fixes.push({
      dim: "频谱舒适度",
      zh: "高频毛刺或低频轰隆，长时间听会累：要求整体音色温暖平衡。",
      en: "Keep the tone warm and balanced; no harsh highs, no boomy low end.",
    });
  }

  // 音节率是清晰度维度的说明里给的，单独拎出来提醒歌词侧
  const clarityDetail = byKey.get("clarity")?.detail ?? "";
  const syllable = clarityDetail.match(/音节率代理\s*([\d.]+)/);
  if (syllable && Number(syllable[1]) > 4.5) {
    positiveStyle = addTags(positiveStyle, ["slow clear syllable rate", "short lines"]);
    fixes.push({
      dim: "语速",
      zh: `每秒 ${syllable[1]} 个音节，对低龄偏快：缩短每行字数、放慢咬字。`,
      en: "Slow the syllable rate: fewer words per line, unhurried diction.",
    });
  }

  return {
    weakDims: weak.map((dim) => dim.key),
    fixes,
    music: { bpm, lowestNote, highestNote, positiveStyle, negativeStyle },
    exhausted: fixes.length === 0,
  };
}

/** 把建议拼成给模型看的英文补充说明。 */
export function fixesToPromptEn(fixes: DoctorFix[]): string {
  return fixes.map((fix) => fix.en).join(" ");
}
