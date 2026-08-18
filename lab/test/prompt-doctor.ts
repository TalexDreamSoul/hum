/**
 * 提示词医生冒烟：判词 → 具体改法与下一轮参数。
 * 跑法：node test/prompt-doctor.ts
 */

import { diagnose } from "../lib/prompt-doctor.ts";

let failed = 0;
function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

const base = {
  scene: "morning" as const,
  total: 56,
  threshold: 70,
  pointCount: 4,
  music: {
    bpm: 120,
    lowestNote: "D4",
    highestNote: "F5",
    positiveStyle: ["children song"],
    negativeStyle: [],
  },
};

const plan = diagnose({
  ...base,
  dims: [
    { key: "loudness", score: 65, detail: "真峰值 2 dBTP 已超 0" },
    { key: "tempo", score: 12, detail: "98.4 BPM，场景带 116–148" },
    { key: "range", score: 69, detail: "音域跨度 15 半音" },
    { key: "repetition", score: 0, detail: "重复帧占比 100%" },
    { key: "clarity", score: 60, detail: "1–4 kHz 占比 9%（单声道），音节率代理 5.15/s" },
    { key: "gaps", score: 80, detail: "留白 3.1 次/分" },
  ],
});

check("弱项被识别", plan.weakDims.join(",") === "loudness,tempo,range,repetition,clarity", plan.weakDims.join(","));
check("节奏锁到场景锚点", plan.music.bpm === 132, String(plan.music.bpm));
check(
  "音域压进一个八度（以原中心收窄）",
  plan.music.lowestNote === "F4" && plan.music.highestNote === "D#5",
  `${plan.music.lowestNote}–${plan.music.highestNote}`,
);
check("每条建议都有中英双版", plan.fixes.every((fix) => fix.zh && fix.en), `${plan.fixes.length} 条`);
check("语速过快单独提醒", plan.fixes.some((fix) => fix.dim === "语速"), plan.fixes.map((f) => f.dim).join("、"));
check("负面词加了防削波", plan.music.negativeStyle.includes("loudness war mastering"), plan.music.negativeStyle.join(", ").slice(0, 60));

const clean = diagnose({
  ...base,
  total: 88,
  dims: [
    { key: "loudness", score: 92, detail: "" },
    { key: "tempo", score: 95, detail: "" },
    { key: "range", score: 90, detail: "" },
  ],
});
check("全部达标时无药可开", clean.exhausted && clean.fixes.length === 0, String(clean.fixes.length));

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
