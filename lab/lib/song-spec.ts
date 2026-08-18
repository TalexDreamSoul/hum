import { z } from "zod";
import { THEME_TUNING_VALUES } from "./theme-song";

const identifier = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, "标识只能包含小写字母、数字和连字符");
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "必须是 sha256:<64位小写十六进制>");

export const songSpecContentSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(160),
  language: z.string().trim().min(2).max(32),
  domain: z.string().trim().min(1).max(160),
  audience: z.string().trim().min(1).max(80),
  scene: z.enum(["general", "morning", "bath", "commute", "meal", "play", "focus", "travel", "bedtime"]),
  hook: z.string().trim().max(160).default(""),
  notes: z.string().trim().max(2000).default(""),
  source: z.object({
    type: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(240),
    version: z.string().trim().min(1).max(120),
    license: z.string().trim().min(1).max(120),
    excerpt: z.string().trim().min(1).max(20_000),
    sourceHash: sha256,
  }).strict(),
  learning: z.object({
    objective: z.string().trim().min(1).max(1000),
    retrievalMode: z.literal("sentence-final-answer"),
    prerequisites: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
    contentRisk: z.enum(["low", "medium", "high"]),
  }).strict(),
  music: z.object({
    tuning: z.object({
      id: z.enum(THEME_TUNING_VALUES),
      version: z.literal(1),
    }).strict().default({ id: "general", version: 1 }),
    durationSec: z.number().int().min(10).max(600),
    bpm: z.number().int().min(40).max(200),
    key: z.string().trim().min(1).max(40),
    lowestNote: z.string().trim().min(1).max(16),
    highestNote: z.string().trim().min(1).max(16),
    voice: z.string().trim().min(1).max(160),
    positiveStyle: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
    negativeStyle: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
    /** 这首歌专属的音乐说明：中文给运营看，英文直接进模型提示词 */
    brief: z.object({
      zh: z.string().trim().max(400),
      en: z.string().trim().max(400),
    }).strict().optional(),
  }).strict(),
  sections: z.array(z.object({
    id: identifier,
    type: z.enum(["intro", "verse", "pre_chorus", "chorus", "interlude", "bridge", "outro", "transition", "break", "hook", "solo"]),
    targetSec: z.number().int().min(3).max(120),
  }).strict()).min(1).max(30),
  points: z.array(z.object({
    id: identifier,
    lead: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(200),
    answerPosition: z.literal("line_end"),
    minAnswerWindowMs: z.number().int().min(300).max(10_000),
    maxAnswerWindowMs: z.number().int().min(300).max(10_000),
    cue: z.string().trim().max(160).default(""),
  }).strict()).min(1).max(100),
  generation: z.object({
    requiredOutputs: z.array(z.enum(["mixed", "vocal_stem", "accompaniment_stem", "word_timestamps"])).min(1).max(4),
    seedPolicy: z.literal("record-required"),
    providerPolicy: z.literal("batch-compare"),
  }).strict(),
}).strict().superRefine((content, context) => {
  if (!content.generation.requiredOutputs.includes("mixed")) {
    context.addIssue({ code: "custom", path: ["generation", "requiredOutputs"], message: "必须包含 mixed" });
  }
  if (new Set(content.sections.map((section) => section.id)).size !== content.sections.length) {
    context.addIssue({ code: "custom", path: ["sections"], message: "section id 必须唯一" });
  }
  if (new Set(content.points.map((point) => point.id)).size !== content.points.length) {
    context.addIssue({ code: "custom", path: ["points"], message: "point id 必须唯一" });
  }
  content.points.forEach((point, index) => {
    if (point.minAnswerWindowMs > point.maxAnswerWindowMs) {
      context.addIssue({ code: "custom", path: ["points", index, "minAnswerWindowMs"], message: "answer window 下限不能大于上限" });
    }
  });
});

export const createSongSpecSchema = z.object({
  specKey: identifier,
  parentId: z.string().uuid().optional(),
  content: songSpecContentSchema,
}).strict();

export type SongSpecContent = z.infer<typeof songSpecContentSchema>;

export function buildSongSpecLyrics(content: SongSpecContent): string {
  const hook = content.hook || content.title;
  const points = content.points;
  // 副歌每次换掉句尾答案：既避免整首自相似度顶满，也把不同知识点轮着考一遍
  const chorus = (index: number) => `${hook}，${points[index % points.length].answer}`;

  const lines: string[] = ["[Chorus]", chorus(0)];
  let chorusIndex = 1;
  points.forEach((point, index) => {
    if (index % 2 === 0) lines.push("[Verse]");
    lines.push(`${point.lead}${point.answer}`);
    // 每两句主歌插一次副歌，且换一个答案
    if (index % 2 === 1 && index !== points.length - 1) {
      lines.push("[Chorus]", chorus(chorusIndex));
      chorusIndex += 1;
    }
  });

  // 桥段用问句复述最后一个知识点，句尾留白让孩子接
  const last = points[points.length - 1];
  lines.push("[Bridge]", `一起想一想，${last.lead}什么？`);
  lines.push("[Chorus]", chorus(chorusIndex));
  return lines.join("\n");
}

export function buildSongSpecPrompt(content: SongSpecContent): string {
  const negatives = content.music.negativeStyle.map((style) => style.startsWith("no ") ? style : `no ${style}`);
  const brief = content.music.brief?.en?.trim();
  return [
    // 主题专属描述排在最前面，模板化的风格词只做补充
    ...(brief ? [brief] : []),
    ...content.music.positiveStyle,
    ...negatives,
    `${content.music.bpm} BPM`,
    `key of ${content.music.key}`,
    `vocal range ${content.music.lowestNote} to ${content.music.highestNote}`,
    content.music.voice,
    "clear precise mandarin diction",
  ].join(", ").slice(0, 2000);
}
