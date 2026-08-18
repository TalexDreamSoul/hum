/**
 * 歌词时间轴：MiniMax 这类音乐模型不返回逐行时间戳，所以用我们自己的留白检测反推。
 *
 * 思路：句子之间必然有停顿。取最大的 N-1 段留白当分界，把歌词按行切进这些区间；
 * 留白不够时退回按字数在总时长里加权分配。产物同时能导出成 .lrc。
 */

export interface LyricLineTiming {
  index: number;
  text: string;
  start: number;
  end: number;
  /** true = 用留白对齐，false = 按字数估算 */
  aligned: boolean;
}

export interface GapSpan {
  start: number;
  end: number;
}

/** 去掉 [Chorus] 这类段落标记，只留可唱的行。 */
export function lyricLines(lyrics: string): string[] {
  return lyrics
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.+\]$/.test(line));
}

function weightedFallback(lines: string[], durationSec: number): LyricLineTiming[] {
  const weights = lines.map((line) => Math.max(1, line.replace(/\s/g, "").length));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return lines.map((text, index) => {
    const span = (weights[index] / total) * durationSec;
    const start = cursor;
    cursor += span;
    return { index, text, start, end: cursor, aligned: false };
  });
}

export function buildLyricsTimeline(
  lyrics: string,
  durationSec: number,
  gaps: GapSpan[],
): LyricLineTiming[] {
  const lines = lyricLines(lyrics);
  if (!lines.length || !(durationSec > 0)) return [];
  if (lines.length === 1) return [{ index: 0, text: lines[0], start: 0, end: durationSec, aligned: false }];

  // 只考虑落在音频中间的留白，开头结尾的静音不算句间停顿
  const usable = gaps
    .filter((gap) => gap.end > 0.3 && gap.start < durationSec - 0.3 && gap.end > gap.start)
    .map((gap) => ({ ...gap, length: gap.end - gap.start }));

  if (usable.length < lines.length - 1) return weightedFallback(lines, durationSec);

  // 取最长的 N-1 段留白做分界，用留白中点当切点
  const boundaries = usable
    .sort((left, right) => right.length - left.length)
    .slice(0, lines.length - 1)
    .map((gap) => (gap.start + gap.end) / 2)
    .sort((left, right) => left - right);

  const edges = [0, ...boundaries, durationSec];
  return lines.map((text, index) => ({
    index,
    text,
    start: edges[index],
    end: edges[index + 1],
    aligned: true,
  }));
}

function lrcStamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `[${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}]`;
}

/** 导出标准 LRC，能直接喂给 /lab 的歌词分析和任何播放器。 */
export function toLrc(timeline: LyricLineTiming[], meta?: { title?: string; artist?: string }): string {
  const head: string[] = [];
  if (meta?.title) head.push(`[ti:${meta.title}]`);
  if (meta?.artist) head.push(`[ar:${meta.artist}]`);
  return [...head, ...timeline.map((line) => `${lrcStamp(line.start)}${line.text}`)].join("\n");
}
