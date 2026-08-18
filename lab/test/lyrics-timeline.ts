/**
 * 歌词时间轴冒烟：留白够就按留白对齐，不够就按字数估算。
 * 跑法：node test/lyrics-timeline.ts
 */

import { buildLyricsTimeline, lyricLines, toLrc } from "../lib/analysis/lyrics-timeline.ts";

let failed = 0;
function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

const LYRICS = "[Chorus]\n红灯停下绿灯行\n[Verse]\n看见红灯要停下\n看见绿灯才通行";

check("段落标记不算行", lyricLines(LYRICS).length === 3, String(lyricLines(LYRICS).length));

const gaps = [
  { start: 0, end: 0.2 },        // 开头静音，不算句间
  { start: 9.5, end: 10.5 },     // 句间
  { start: 19.0, end: 20.5 },    // 句间（更长）
];
const aligned = buildLyricsTimeline(LYRICS, 30, gaps);
check("留白够时按留白切", aligned.length === 3 && aligned.every((line) => line.aligned), JSON.stringify(aligned.map((l) => l.start.toFixed(1))));
check("切点落在留白中点", Math.abs(aligned[1].start - 10) < 0.01 && Math.abs(aligned[2].start - 19.75) < 0.01, `${aligned[1].start} / ${aligned[2].start}`);

const fallback = buildLyricsTimeline(LYRICS, 30, []);
check("留白不够时退回估算", fallback.length === 3 && fallback.every((line) => !line.aligned), JSON.stringify(fallback.map((l) => l.start.toFixed(1))));
check("首行从 0 开始、末行到结尾", fallback[0].start === 0 && Math.abs(fallback[2].end - 30) < 0.01, `${fallback[0].start} → ${fallback[2].end}`);

const lrc = toLrc(aligned, { title: "过马路" });
check("LRC 带标题与时间戳", lrc.startsWith("[ti:过马路]") && /\[00:10\.00\]看见红灯要停下/.test(lrc), lrc.split("\n")[2]);

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
