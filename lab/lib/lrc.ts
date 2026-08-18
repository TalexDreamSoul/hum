/**
 * LRC 歌词解析与本地指标（不依赖 AI，随文件即时计算）。
 *
 * 本地能算的：语速（字/秒，按时间戳）、重复行占比（文本级副歌检测）、
 * 行长分布，以及最有 hum 特色的一条——**可接唱行占比**：
 * 一行歌词唱完后，音频里是否紧跟一个已检出的留白窗口（歌词与声学的交叉验证）。
 */

export interface LrcLine {
  t: number;
  text: string;
}

export interface LyricsLineMetric {
  t: number;
  text: string;
  chars: number;
  cps: number; // 字/秒
  clozeReady: boolean | null;
}

export interface LyricsLocal {
  lineCount: number;
  charCount: number;
  medianCps: number | null;
  /** 语速超过 4.5 字/秒的行占比（低龄跟读上限的工程估计） */
  fastShare: number | null;
  /** 完全重复行占比（副歌钩子的文本证据） */
  dupLineShare: number;
  /** 行尾落在声学留白上的行占比；无 gaps 数据时为 null */
  clozeReadyShare: number | null;
  perLine: LyricsLineMetric[];
}

const META_TAG = /^\[(ti|ar|al|by|offset|re|ve)[^\]]*\]/i;
const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(raw: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || META_TAG.test(line.trim())) continue;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    TIME_TAG.lastIndex = 0;
    while ((m = TIME_TAG.exec(line))) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    const text = line.replace(TIME_TAG, "").trim();
    if (!times.length || !text) continue;
    for (const t of times) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

const countChars = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").length;
const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

export function computeLyricsLocal(
  lines: LrcLine[],
  durationSec: number,
  gaps?: { start: number; end: number }[],
): LyricsLocal {
  const perLine: LyricsLineMetric[] = [];
  const norm: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].t;
    const end = Math.min(lines[i + 1]?.t ?? t + 6, durationSec || t + 6);
    const dur = Math.max(end - t, 0.4);
    const chars = countChars(lines[i].text);
    let clozeReady: boolean | null = null;
    if (gaps && gaps.length) {
      clozeReady = gaps.some((g) => (g.start >= end - 0.6 && g.start <= end + 1.0) || (g.start <= end && g.end >= end));
    }
    perLine.push({
      t, text: lines[i].text, chars,
      cps: Math.round((chars / dur) * 100) / 100,
      clozeReady,
    });
    norm.push(normalize(lines[i].text));
  }

  const cpsAll = perLine.filter((l) => l.chars >= 2).map((l) => l.cps).sort((a, b) => a - b);
  const medianCps = cpsAll.length ? cpsAll[Math.floor(cpsAll.length / 2)] : null;
  const fastShare = cpsAll.length
    ? Math.round((cpsAll.filter((v) => v > 4.5).length / cpsAll.length) * 1000) / 1000
    : null;

  const distinct = new Set(norm).size;
  const dupLineShare = norm.length ? Math.round((1 - distinct / norm.length) * 1000) / 1000 : 0;

  const clozeKnown = perLine.filter((l) => l.clozeReady !== null);
  const clozeReadyShare = clozeKnown.length
    ? Math.round((clozeKnown.filter((l) => l.clozeReady).length / clozeKnown.length) * 1000) / 1000
    : null;

  return {
    lineCount: perLine.length,
    charCount: perLine.reduce((a, l) => a + l.chars, 0),
    medianCps, fastShare, dupLineShare, clozeReadyShare, perLine,
  };
}
