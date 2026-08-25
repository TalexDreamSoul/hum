import { z } from "zod";
import { THEME_LYRIC_STYLE_VALUES, THEME_TUNING_VALUES } from "./theme-song";

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
  lyrics: z.object({
    style: z.object({
      id: z.enum(THEME_LYRIC_STYLE_VALUES),
      version: z.literal(1),
    }).strict().default({ id: "general", version: 1 }),
    coreMemoryLine: z.string().trim().max(80).default(""),
    logicLinks: z.array(z.object({
      fromPointId: identifier,
      toPointId: identifier,
      relation: z.enum(["sequence", "cause", "contrast", "classification", "condition", "result"]),
      connector: z.string().trim().min(1).max(40),
    }).strict()).max(99).default([]),
  }).strict().default({ style: { id: "general", version: 1 }, coreMemoryLine: "", logicLinks: [] }),
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
  const pointIds = new Set(content.points.map((point) => point.id));
  content.lyrics.logicLinks.forEach((link, index) => {
    if (!pointIds.has(link.fromPointId) || !pointIds.has(link.toPointId)) {
      context.addIssue({ code: "custom", path: ["lyrics", "logicLinks", index], message: "歌词逻辑链必须引用已有知识点" });
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
  const hook = (content.lyrics.coreMemoryLine || content.hook || content.title).replace(/[，。！？!?；;：:]+$/u, "");
  const points = content.points;
  const style = content.lyrics.style.id;
  const tagByType: Record<SongSpecContent["sections"][number]["type"], string> = {
    intro: "Intro", verse: "Verse", pre_chorus: "Pre Chorus", chorus: "Chorus", interlude: "Interlude",
    bridge: "Bridge", outro: "Outro", transition: "Transition", break: "Break", hook: "Hook", solo: "Solo",
  };
  const linkByTarget = new Map(content.lyrics.logicLinks.map((link) => [link.toPointId, link]));
  const narrativeCount = content.sections.filter((section) => section.type === "verse" || section.type === "pre_chorus").length;
  const pointsPerNarrative = Math.max(1, Math.ceil(points.length / Math.max(1, narrativeCount)));
  const lines: string[] = [];
  let pointIndex = 0;
  let refrainIndex = 0;

  const pointLines = (point: SongSpecContent["points"][number]) => {
    const link = linkByTarget.get(point.id);
    const connector = link ? `${link.connector}，` : "";
    if (style === "call-response") return [`${connector}${point.lead}`, `答案就在句尾，${point.answer}`];
    if (style === "narrative") return [`${connector}${point.lead}${point.answer}`];
    if (style === "mnemonic") return [`${hook}，${connector}${point.lead}${point.answer}`];
    return [`${connector}${point.lead}${point.answer}`];
  };

  for (const section of content.sections) {
    lines.push(`[${tagByType[section.type]}]`);
    if (section.type === "verse" || section.type === "pre_chorus") {
      const limit = Math.min(points.length, pointIndex + pointsPerNarrative);
      while (pointIndex < limit) {
        lines.push(...pointLines(points[pointIndex]));
        pointIndex += 1;
      }
      continue;
    }
    if (section.type === "chorus" || section.type === "hook" || section.type === "outro") {
      const point = points[refrainIndex % points.length];
      lines.push(`${hook}，记住${point.answer}`);
      refrainIndex += 1;
      continue;
    }
    if (section.type === "bridge") {
      const point = points[Math.max(0, pointIndex - 1) % points.length];
      lines.push(`${hook}，${point.lead}${point.answer}`);
    }
  }
  return lines.join("\n");
}

export interface LyricStructureAssessment {
  total: number;
  passed: boolean;
  dimensions: Array<{ key: string; label: string; score: number; threshold: number; verdict: "pass" | "fail"; evidence: Record<string, unknown> }> ;
}

export function evaluateLyricStructure(content: SongSpecContent, lyrics: string): LyricStructureAssessment {
  const lyricLines = lyrics.split("\n").filter((line) => line && !line.startsWith("["));
  const expectedLinks = Math.max(0, content.points.length - 1);
  const answerHits = content.points.filter((point) => lyrics.includes(point.answer)).length;
  const hook = content.lyrics.coreMemoryLine || content.hook || content.title;
  const hookHits = hook ? lyrics.split(hook).length - 1 : 0;
  const longLines = lyricLines.filter((line) => [...line].length > 32).length;
  const styleEvidence = content.lyrics.style.id === "call-response"
    ? lyricLines.filter((line) => line.startsWith("答案就在句尾，")).length
    : content.lyrics.style.id === "mnemonic" ? hookHits : content.lyrics.logicLinks.length;
  const dimensions = [
    { key: "logic_continuity", label: "逻辑连贯", score: expectedLinks ? Math.round(100 * Math.min(content.lyrics.logicLinks.length, expectedLinks) / expectedLinks) : 100, threshold: 100, evidence: { expectedLinks, actualLinks: content.lyrics.logicLinks.length } },
    { key: "answer_integrity", label: "知识答案完整", score: Math.round(100 * answerHits / Math.max(1, content.points.length)), threshold: 100, evidence: { answerHits, pointCount: content.points.length } },
    { key: "memory_hook", label: "核心记忆句", score: hook ? Math.min(100, hookHits * 50) : 0, threshold: 100, evidence: { hook, hookHits } },
    { key: "style_execution", label: "歌词风格执行", score: styleEvidence > 0 ? 100 : 0, threshold: 100, evidence: { style: content.lyrics.style.id, styleEvidence } },
    { key: "line_clarity", label: "短句清晰", score: Math.round(100 * (1 - longLines / Math.max(1, lyricLines.length))), threshold: 80, evidence: { lineCount: lyricLines.length, longLines } },
  ].map((dimension) => ({ ...dimension, verdict: (dimension.score >= dimension.threshold ? "pass" : "fail") as "pass" | "fail" }));
  const total = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length);
  return { total, passed: dimensions.every((dimension) => dimension.verdict === "pass"), dimensions };
}

export function buildSongSpecPrompt(content: SongSpecContent): string {
  const negatives = content.music.negativeStyle.map((style) => style.startsWith("no ") ? style : `no ${style}`);
  const brief = content.music.brief?.en?.trim();
  const structure = content.sections.map((section) => section.type.replace("_", " " )).join(" > " );
  return [
    ...(brief ? [brief] : []),
    ...content.music.positiveStyle,
    ...negatives,
    "start every sung section directly with the written lyric on beat one",
    "instrumental sections must stay instrumental; no humming, wordless vocalise, ah-oh, ooh or la-la filler",
    `follow this section order: ${structure}`,
    `target approximately ${content.music.durationSec} seconds without padding the song with vocal filler`,
    `${content.music.bpm} BPM`,
    `key of ${content.music.key}`,
    `vocal range ${content.music.lowestNote} to ${content.music.highestNote}`,
    content.music.voice,
    "clear precise mandarin diction",
  ].join(", " ).slice(0, 2000);
}
