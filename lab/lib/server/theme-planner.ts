import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildSongSpecLyrics, buildSongSpecPrompt, evaluateLyricStructure, songSpecContentSchema, type SongSpecContent } from "../song-spec";
import {
  THEME_AGE_BAND_ITEMS,
  THEME_AGE_DURATION_SEC,
  THEME_LYRIC_STYLE_ITEMS,
  THEME_LYRIC_STYLE_VALUES,
  THEME_SCENE_ITEMS,
  THEME_TUNING_ITEMS,
  THEME_TUNING_VALUES,
  type ThemeAgeBand,
  type ThemeLyricStyle,
  type ThemeScene,
  type ThemeTuning,
  type ThemeSongPlan,
} from "../theme-song";
import { ApiError } from "./api";
import type { JobTracker } from "./jobs";
import { createMockKnowledgeExpansion, mockMarker } from "./mock-provider";
import { sha256 } from "./song-specs";
import { resolveSkills } from "./skills";

export const themePlanInputSchema = z.object({
  theme: z.string().trim().min(2, "主题至少需要 2 个字").max(120),
  ageBand: z.enum(["3-4", "5-6", "7-8", "9-12"]),
  scene: z.enum(["general", "morning", "bath", "commute", "meal", "play", "focus", "travel", "bedtime"]),
  tuning: z.enum(THEME_TUNING_VALUES).default("general"),
  lyricStyle: z.enum(THEME_LYRIC_STYLE_VALUES).default("general"),
  sourceNotes: z.string().trim().max(6000).default(""),
}).strict();

// 不同模型的 JSON 习惯不一样：字段名、大小写、包一层 plan、把数组写成字符串都见过。
// 这里先归一化，再做校验，模型只需要把「知识点」讲对，格式差异由我们吸收。
const knowledgePlanSchema = z.object({
  slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能是小写字母、数字和连字符"),
  title: z.string().trim().min(1).max(80),
  domain: z.string().trim().min(1).max(80),
  objective: z.string().trim().min(1).max(300),
  hook: z.string().trim().min(1).max(60),
  summary: z.string().trim().min(1).max(600),
  prerequisites: z.array(z.string().trim().min(1).max(80)).max(8),
  contentRisk: z.enum(["low", "medium", "high"]),
  musicZh: z.string().trim().max(400),
  musicEn: z.string().trim().max(400),
  styleTags: z.array(z.string().trim().min(1).max(60)).max(10),
  avoidTags: z.array(z.string().trim().min(1).max(60)).max(8),
  points: z.array(z.object({
    lead: z.string().trim().min(1).max(120),
    answer: z.string().trim().min(1).max(24),
    cue: z.string().trim().max(40),
  })).min(3, "至少需要 3 个知识点").max(10),
  logicLinks: z.array(z.object({
    fromIndex: z.number().int().min(0).max(9),
    toIndex: z.number().int().min(0).max(9),
    relation: z.enum(["sequence", "cause", "contrast", "classification", "condition", "result"]),
    connector: z.string().trim().min(1).max(40),
  })).max(9).default([]),
});

type KnowledgePlan = z.infer<typeof knowledgePlanSchema>;

interface AgePolicy {
  audience: string;
  maxPoints: number;
  maxAnswerChars: number;
  durationSec: number;
  lowestNote: string;
  highestNote: string;
  voice: string;
  window: [number, number];
  positiveStyle: string[];
  negativeStyle: string[];
}

const AGE_POLICIES: Record<ThemeAgeBand, AgePolicy> = {
  "3-4": {
    audience: "3–4 岁儿童",
    maxPoints: 4,
    maxAnswerChars: 6,
    durationSec: THEME_AGE_DURATION_SEC["3-4"],
    lowestNote: "D4",
    highestNote: "A4",
    voice: "warm gentle adult female vocal, child-friendly and unhurried",
    window: [1600, 2400],
    positiveStyle: ["children song", "simple pentatonic melody", "short repeated phrases", "clear Mandarin"],
    negativeStyle: ["wide vocal range", "dense lyrics", "fast articulation", "dramatic belting"],
  },
  "5-6": {
    audience: "5–6 岁儿童",
    maxPoints: 5,
    maxAnswerChars: 8,
    durationSec: THEME_AGE_DURATION_SEC["5-6"],
    lowestNote: "D4",
    highestNote: "B4",
    voice: "warm clear female vocal, natural Mandarin diction",
    window: [1400, 2200],
    positiveStyle: ["children song", "simple memorable melody", "repeated chorus", "clear Mandarin"],
    negativeStyle: ["wide vocal range", "dense arrangement", "fast articulation", "vocal runs"],
  },
  "7-8": {
    audience: "7–8 岁儿童",
    maxPoints: 6,
    maxAnswerChars: 10,
    durationSec: THEME_AGE_DURATION_SEC["7-8"],
    lowestNote: "C4",
    highestNote: "C5",
    voice: "clear youthful female vocal, precise Mandarin diction",
    window: [1200, 2000],
    positiveStyle: ["educational pop", "memorable chorus", "steady pulse", "clear Mandarin"],
    negativeStyle: ["wide vocal range", "dense lyrics", "syncopated vocal runs", "heavy distortion"],
  },
  "9-12": {
    audience: "9–12 岁儿童",
    maxPoints: 8,
    maxAnswerChars: 14,
    durationSec: THEME_AGE_DURATION_SEC["9-12"],
    lowestNote: "C4",
    highestNote: "D5",
    voice: "natural youthful vocal, articulate Mandarin with restrained expression",
    window: [1000, 1800],
    positiveStyle: ["educational pop", "strong melodic hook", "clear song structure", "clear Mandarin"],
    negativeStyle: ["extreme vocal range", "overly dense arrangement", "mumbled diction", "aggressive distortion"],
  },
};

const BPM_BY_SCENE: Record<ThemeScene, Record<ThemeAgeBand, number>> = {
  general: { "3-4": 112, "5-6": 118, "7-8": 124, "9-12": 128 },
  morning: { "3-4": 120, "5-6": 126, "7-8": 132, "9-12": 136 },
  bath: { "3-4": 116, "5-6": 120, "7-8": 126, "9-12": 130 },
  commute: { "3-4": 108, "5-6": 114, "7-8": 120, "9-12": 124 },
  play: { "3-4": 128, "5-6": 134, "7-8": 140, "9-12": 144 },
  focus: { "3-4": 88, "5-6": 92, "7-8": 96, "9-12": 100 },
  travel: { "3-4": 104, "5-6": 110, "7-8": 114, "9-12": 118 },
  meal: { "3-4": 92, "5-6": 98, "7-8": 104, "9-12": 108 },
  bedtime: { "3-4": 68, "5-6": 72, "7-8": 76, "9-12": 80 },
};

const STYLE_BY_SCENE: Record<ThemeScene, string[]> = {
  general: ["clean children pop", "moderate tempo", "neutral bright tone"],
  morning: ["bright acoustic pop", "light percussion", "positive energy"],
  bath: ["playful bouncy pop", "light claps", "short catchy phrases"],
  commute: ["gentle pop", "steady rhythm", "warm electric piano"],
  play: ["upbeat playful pop", "bouncy percussion", "energetic but not harsh"],
  focus: ["calm steady groove", "minimal percussion", "single clear melodic line"],
  travel: ["easy going pop", "steady mid tempo", "warm acoustic guitar"],
  meal: ["soft acoustic", "low intensity", "background friendly"],
  bedtime: ["gentle lullaby", "soft piano", "no percussion"],
};

interface TuningPreset {
  promptInstruction: string;
  positive: string[];
  negative: string[];
  stripPositive: string[];
  briefZh: string;
  briefEn: string;
}

const TUNING_PRESETS: Record<ThemeTuning, TuningPreset> = {
  general: {
    promptInstruction: "保持当前年龄与场景策略，不额外偏向某种编曲。",
    positive: [], negative: [], stripPositive: [], briefZh: "", briefEn: "",
  },
  strong: {
    promptInstruction: "旋律要一遍可记、两遍可跟唱；使用级进四句钩子、短副歌和清晰问答，弱化一切电音质感。",
    positive: ["instantly memorable stepwise four-bar hook", "short repeated singalong chorus", "front-and-center natural vocal", "acoustic pop with handclaps and light live drums", "simple stable diatonic melody"],
    negative: ["EDM", "electropop", "synth lead", "festival drop", "sidechain pumping", "sub-bass", "vocoder", "robotic vocal", "busy electronic arpeggio"],
    stripPositive: ["edm", "electro", "synth", "sidechain", "sub-bass", "festival drop"],
    briefZh: "强化朗朗上口：主歌克制，副歌用四句级进短钩子重复；主唱靠前自然，木吉他、钢琴、拍手和轻现场鼓为主，禁止明显电音音色与 drop。",
    briefEn: "Prioritize an instantly singable four-bar hook and a short repeated chorus. Keep the natural lead vocal forward; use acoustic instruments and light live drums, with no electronic drop or synth lead.",
  },
  earworm: {
    promptInstruction: "用有意义歌词制造耳虫：核心记忆句控制在 3–7 个汉字，前 8 秒直接唱出，此后每 15–20 秒回归；重复时轮换知识答案，禁止用哼哼、啊、哦、啦啦等无词填充。",
    positive: ["semantic earworm hook on beat one", "three-to-seven-syllable memory phrase", "tight two-bar melodic motif", "frequent lyric-led hook returns", "clear call-and-answer accents"],
    negative: ["wordless humming", "ah-oh-la-la filler", "long ambient intro", "through-composed melody", "random vocal ad-libs"],
    stripPositive: ["ambient intro", "wordless", "vocalise"],
    briefZh: "洗脑调优：开头第一拍直接唱 3–7 字核心记忆句，两小节旋律动机贯穿全曲；每次回归替换知识答案，不使用哼哼、啊哦或啦啦填时长。",
    briefEn: "Open on beat one with a meaningful three-to-seven-syllable lyric hook. Recur every 15–20 seconds with rotating knowledge answers; use no humming, wordless vocalise, ah-oh or la-la filler.",
  },
  rock: {
    promptInstruction: "采用儿童友好的明亮流行摇滚：真鼓、清晰吉他 riff 和可齐唱副歌；有力量但不嘶吼、不重金属化。",
    positive: ["bright child-friendly pop rock", "clean electric guitar riff", "punchy live drums", "handclap gang response", "big melodic singalong chorus"],
    negative: ["heavy metal", "screaming vocal", "harsh distortion", "double-kick drums", "long guitar solo over lyrics"],
    stripPositive: ["metal", "aggressive distortion", "club beat"],
    briefZh: "摇滚调优：用清晰电吉他动机和真鼓推动主歌，预副歌抬升后进入可齐唱副歌；保持自然普通话与儿童可唱音域。",
    briefEn: "Use a clean electric-guitar motif and punchy live drums, rising through a short pre-chorus into a melodic gang-sing chorus. Keep the vocal natural, clear and child-singable, never metal or screamed.",
  },
  jazz: {
    promptInstruction: "采用儿童友好的轻爵士：钢琴、低音提琴与轻刷鼓构成稳定律动，旋律清晰易唱；禁止无词 scat 和复杂即兴。",
    positive: ["warm child-friendly jazz", "acoustic piano comping", "upright bass", "light brushed drums", "clear melodic singalong vocal"],
    negative: ["wordless scat singing", "dense bebop improvisation", "dissonant harmony", "long instrumental solo"],
    stripPositive: ["scat", "bebop", "improvisation"],
    briefZh: "爵士调优：钢琴、低音提琴和刷鼓提供温暖稳定的律动；每句旋律清楚可唱，不加入无词即兴或长篇器乐 solo。",
    briefEn: "Use warm piano, upright bass and light brushes for a stable child-friendly jazz groove. Keep every lyric melody clear and singable; no scat, dense improvisation or long instrumental solo.",
  },
  folk: {
    promptInstruction: "采用儿童友好的现代民谣：木吉他主导、轻打击乐和自然人声，叙述清晰、节奏稳定，副歌可跟唱。",
    positive: ["warm contemporary folk", "fingerpicked acoustic guitar", "light hand percussion", "natural Mandarin vocal", "simple singalong chorus"],
    negative: ["heavy drums", "electronic drop", "wordless vocalise", "dense orchestration"],
    stripPositive: ["edm", "synth", "drop"],
    briefZh: "民谣调优：用木吉他和轻打击乐承托自然叙述，主歌清楚讲知识，副歌保持短小可跟唱。",
    briefEn: "Lead with fingerpicked acoustic guitar and light hand percussion. Keep the verses narratively clear and the chorus short, melodic and easy to sing along with.",
  },
  trendy: {
    promptInstruction: "采用当代潮流流行的紧凑律动、清爽音色和短转场，但不得模仿任何具体艺人、歌曲或平台热梗。",
    positive: ["contemporary youth pop", "clean syncopated plucks", "organic percussion with a punchy groove", "short pre-chorus lift", "modern melodic hook"],
    negative: ["specific artist imitation", "viral-song imitation", "nightclub drop", "excessive autotune", "overpowering sub-bass"],
    stripPositive: ["festival drop", "artist-style", "sub-bass"],
    briefZh: "潮流调优：用轻巧切分、清爽 pluck 和短促转场建立当代感，副歌保留完整旋律与清楚咬字，不复制具体艺人或热歌。",
    briefEn: "Build a current youth-pop feel with clean syncopated plucks, organic percussion and compact transitions. Preserve a fully melodic, clearly articulated chorus; do not imitate any artist or existing hit.",
  },
  rap: {
    promptInstruction: "主歌使用清楚押拍的儿童友好说唱短句，知识答案落在行尾；副歌必须可唱。禁止含混快嘴、攻击性 drill、脏话和重低音轰炸。",
    positive: ["child-friendly melodic rap", "clear on-beat Mandarin spoken verse", "simple 88–104 BPM hip-hop groove", "fully sung memorable chorus", "call-and-response rhyme accents"],
    negative: ["mumble rap", "profanity", "aggressive drill", "trap hi-hat barrage", "extreme sub-bass", "rapid double-time flow", "fully spoken chorus"],
    stripPositive: ["fast rap", "drill", "trap", "sub-bass"],
    briefZh: "说唱调优：主歌每行一个知识点，字头落拍、答案收在句尾；用简洁 hip-hop groove 承托，副歌切回有旋律的短钩子。",
    briefEn: "Use short, clearly articulated on-beat Mandarin rap lines with one knowledge point per line and answers at line endings. Return to a fully sung melodic hook; avoid mumble, drill, double-time flow and heavy sub-bass.",
  },
  acoustic: {
    promptInstruction: "以真实原声乐器和自然人声为主，减少合成器与过度制作。",
    positive: ["warm acoustic guitar", "simple piano", "light live percussion", "natural close vocal", "organic room sound"],
    negative: ["synth lead", "electronic drop", "vocoder", "overprocessed vocal", "sub-bass"],
    stripPositive: ["synth", "electro", "edm", "sub-bass"],
    briefZh: "原声调优：用木吉他、钢琴和轻现场打击乐支撑自然人声，保留呼吸感和清晰咬字。",
    briefEn: "Use an organic acoustic arrangement with guitar, piano and light live percussion. Keep the vocal natural, close and clearly articulated.",
  },
  singalong: {
    promptInstruction: "强化儿童接唱：问句短、答案落句尾，副歌重复并在答案前留下明显呼吸和停顿。",
    positive: ["call-and-response singalong", "short repeated chorus", "clear answer pauses", "easy stepwise melody", "group response accents"],
    negative: ["long melisma", "dense backing vocals", "rapid lyrics", "through-composed structure"],
    stripPositive: [],
    briefZh: "接唱调优：用短问短答和重复副歌，答案前明确留出可听见的停顿，旋律以级进和窄音域为主。",
    briefEn: "Build a clear call-and-response singalong with short repeated chorus lines, audible pauses before answers, stepwise motion and a narrow vocal range.",
  },
  gentle: {
    promptInstruction: "降低信息和编曲密度，保持温暖、安静和稳定，不制造突然的动态变化。",
    positive: ["gentle warm melody", "soft piano", "light acoustic texture", "calm close vocal", "slow breathing phrases"],
    negative: ["hard drums", "sudden drop", "bright synth", "shouting", "dense arrangement"],
    stripPositive: ["energetic", "bouncy", "hard", "bright synth"],
    briefZh: "轻柔调优：减少打击乐和层次，使用柔和钢琴与原声织体，动态稳定，不突然抬升。",
    briefEn: "Keep the arrangement warm, sparse and dynamically stable, led by soft piano or acoustic textures with a calm close vocal and no sudden lift.",
  },
  "body-groove": {
    promptInstruction: "用拍手、跺脚和口头节奏建立清楚律动，让知识点能跟着身体动作记住。",
    positive: ["body percussion groove", "handclaps and foot stomps", "clear two-bar rhythm motif", "spoken rhythmic cues", "playful group response"],
    negative: ["heavy drum kit", "complex syncopation", "club beat", "sub-bass", "fast rap"],
    stripPositive: ["club", "sub-bass", "edm"],
    briefZh: "律动调优：以拍手、跺脚和口头节奏组成两小节节拍钩子，让每个知识点对应一个身体动作。",
    briefEn: "Use handclaps, foot stomps and spoken rhythmic cues to form a clear two-bar body-percussion hook, with one physical gesture for each knowledge point.",
  },
};

const SECTION_PATTERN_BY_TUNING: Record<ThemeTuning, SongSpecContent["sections"][number]["type"][]> = {
  general: ["verse", "chorus", "verse", "bridge", "chorus", "outro"],
  strong: ["hook", "verse", "chorus", "verse", "bridge", "chorus", "outro"],
  earworm: ["hook", "verse", "hook", "verse", "bridge", "hook", "outro"],
  rock: ["intro", "verse", "pre_chorus", "chorus", "verse", "solo", "chorus", "outro"],
  jazz: ["intro", "verse", "chorus", "interlude", "verse", "chorus", "outro"],
  folk: ["intro", "verse", "chorus", "verse", "bridge", "chorus", "outro"],
  trendy: ["intro", "hook", "verse", "chorus", "break", "verse", "chorus", "outro"],
  rap: ["intro", "verse", "hook", "verse", "bridge", "hook", "outro"],
  acoustic: ["intro", "verse", "chorus", "verse", "chorus", "outro"],
  singalong: ["verse", "chorus", "verse", "bridge", "chorus", "outro"],
  gentle: ["intro", "verse", "chorus", "interlude", "verse", "outro"],
  "body-groove": ["hook", "verse", "hook", "verse", "break", "hook"],
};

const BPM_RANGE_BY_TUNING: Record<ThemeTuning, readonly [number, number]> = {
  general: [40, 200],
  strong: [88, 132],
  earworm: [96, 128],
  rock: [112, 148],
  jazz: [88, 116],
  folk: [76, 108],
  trendy: [100, 132],
  rap: [88, 104],
  acoustic: [72, 112],
  singalong: [84, 120],
  gentle: [60, 92],
  "body-groove": [100, 132],
};

const MUSICAL_KEYS = ["C major", "D major", "E-flat major", "F major", "G major", "A major"] as const;

function stableVariantIndex(value: string, size: number): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ApiError(502, "AI 未返回可解析的主题拆解 JSON");
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new ApiError(502, "AI 返回的主题拆解不是有效 JSON");
  }
}

const RISK_ALIASES: Record<string, "low" | "medium" | "high"> = {
  low: "low", medium: "medium", high: "high", mid: "medium", moderate: "medium",
  低: "low", 中: "medium", 高: "high", 低风险: "low", 中风险: "medium", 高风险: "high",
};

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const hit = Object.keys(source).find((name) => name.toLowerCase().replace(/[_\s-]/g, "") === key);
    if (hit !== undefined && source[hit] !== undefined && source[hit] !== null) return source[hit];
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? single.split(/[，,、;；\n]+/).map((item) => item.trim()).filter(Boolean) : [];
}

function slugify(value: string, fallback: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return /^[a-z0-9]/.test(cleaned) && cleaned.length >= 2 ? cleaned : fallback;
}

/** 把模型返回的各种写法拉平成 knowledgePlanSchema 认识的形状。 */
function normalizeKnowledgePlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let source = raw as Record<string, unknown>;
  // 有的模型会包一层 { plan: {...} } / { result: {...} }
  if (!pick(source, ["points", "knowledgepoints"])) {
    const wrapped = Object.values(source).find((value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && Boolean(pick(value as Record<string, unknown>, ["points", "knowledgepoints"])));
    if (wrapped) source = wrapped as Record<string, unknown>;
  }

  const title = text(pick(source, ["title", "songtitle", "name", "标题"]));
  const rawPoints = pick(source, ["points", "knowledgepoints", "knowledge", "items", "知识点"]);
  const points = (Array.isArray(rawPoints) ? rawPoints : []).map((item) => {
    if (typeof item === "string") {
      // "太阳从东边升起" 这种整句：句尾最后 2–6 个字当答案
      const line = item.trim();
      const answer = line.slice(-4);
      return { lead: line.slice(0, -answer.length), answer, cue: "接唱" };
    }
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      lead: text(pick(record, ["lead", "prompt", "question", "line", "stem", "提示句", "前半句"])),
      answer: text(pick(record, ["answer", "value", "target", "答案"])),
      cue: text(pick(record, ["cue", "hint", "提示"])) || "接唱",
    };
  });

  const usablePoints = points.filter((point) => point.lead && point.answer);
  const rawLinks = pick(source, ["logiclinks", "links", "transitions", "逻辑链"]);
  const logicLinks = (Array.isArray(rawLinks) ? rawLinks : []).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const relation = text(pick(record, ["relation", "type", "关系"])).toLowerCase();
    return {
      fromIndex: Number(pick(record, ["fromindex", "from", "起点"])),
      toIndex: Number(pick(record, ["toindex", "to", "终点"])),
      relation: ["sequence", "cause", "contrast", "classification", "condition", "result"].includes(relation) ? relation : "sequence",
      connector: text(pick(record, ["connector", "transition", "连接句"])) || "接着",
    };
  }).filter((link) => Number.isInteger(link.fromIndex) && Number.isInteger(link.toIndex));
  const asciiOnly = (value: string) => !/[\u4e00-\u9fff]/.test(value);
  const styleTags = list(pick(source, ["styletags", "style", "styles", "风格标签"])).filter(asciiOnly).slice(0, 10);
  const avoidTags = list(pick(source, ["avoidtags", "avoid", "negativestyle", "避免"])).filter(asciiOnly).slice(0, 8);
  const risk = text(pick(source, ["contentrisk", "risk", "risklevel", "风险"])).toLowerCase();
  return {
    slug: slugify(text(pick(source, ["slug", "key", "id"])) || title, `theme-${randomUUID().slice(0, 8)}`),
    title,
    domain: text(pick(source, ["domain", "subject", "category", "领域", "学科"])) || "通识",
    objective: text(pick(source, ["objective", "goal", "learningobjective", "目标"])),
    hook: text(pick(source, ["hook", "chorus", "钩子"])) || title.slice(0, 20),
    summary: text(pick(source, ["summary", "description", "摘要", "总结"])),
    prerequisites: list(pick(source, ["prerequisites", "prerequisite", "前置知识"])).slice(0, 8),
    contentRisk: RISK_ALIASES[risk] ?? "medium",
    musicZh: text(pick(source, ["musiczh", "musicdescriptionzh", "音乐说明", "编曲说明"])),
    musicEn: text(pick(source, ["musicen", "musicdescription", "musicprompt", "music"])),
    styleTags,
    avoidTags,
    points: usablePoints,
    logicLinks: logicLinks.length ? logicLinks : usablePoints.slice(1).map((_, index) => ({ fromIndex: index, toIndex: index + 1, relation: "sequence", connector: "接着" })),
  };
}

async function requestKnowledgePlan(
  input: z.infer<typeof themePlanInputSchema>,
  policy: AgePolicy,
  _signal: AbortSignal,
  job?: JobTracker,
): Promise<KnowledgePlan> {
  const ageLabel = THEME_AGE_BAND_ITEMS.find((item) => item.value === input.ageBand)?.label ?? input.ageBand;
  const skills = await resolveSkills({ purpose: "generation", ageBand: input.ageBand, scene: input.scene });
  const raw = createMockKnowledgeExpansion({ theme: input.theme, maxPoints: policy.maxPoints });
  const parsed = knowledgePlanSchema.parse(normalizeKnowledgePlan(raw));

  job?.artifact("识别", "fields", "Mock 输入识别", {
    fields: [
      { label: "Provider", value: "mock" },
      { label: "主题", value: input.theme },
      { label: "年龄段", value: ageLabel },
      { label: "场景", value: THEME_SCENE_ITEMS.find((item) => item.value === input.scene)?.label ?? input.scene },
      { label: "歌词风格", value: THEME_LYRIC_STYLE_ITEMS.find((item) => item.value === input.lyricStyle)?.label ?? input.lyricStyle },
      { label: "Skills", value: skills.skills.length ? skills.skills.map((skill) => `${skill.name} v${skill.revision}`).join("、") : "未绑定" },
    ],
    ...mockMarker(),
  });
  job?.step("Mock provider 已确定性拆解主题；不调用外部 AI", { ...mockMarker(), theme: input.theme });
  job?.artifact("拆解", "fields", "Mock 识别结果", {
    fields: [
      { label: "标题", value: parsed.title },
      { label: "领域", value: parsed.domain },
      { label: "学习目标", value: parsed.objective },
      { label: "记忆钩子", value: parsed.hook },
      { label: "内容风险", value: parsed.contentRisk },
      { label: "Provider", value: "mock" },
    ],
    ...mockMarker(),
  });
  job?.artifact("拆解", "text", "Mock 一句话摘要", { text: parsed.summary, ...mockMarker() });
  job?.step(`Mock provider 拆解出 ${parsed.points.length} 个知识点`, mockMarker());
  return parsed;
}

function sanitizePoints(plan: KnowledgePlan, policy: AgePolicy) {
  return plan.points.slice(0, policy.maxPoints).map((point, index) => {
    const answer = point.answer.replace(/[，。！？!?；;]+$/u, "").trim();
    if (Array.from(answer).length > policy.maxAnswerChars) {
      throw new ApiError(502, `第 ${index + 1} 个答案超过 ${policy.maxAnswerChars} 个字，请重新拆解`);
    }
    const lead = point.lead.endsWith(answer)
      ? point.lead.slice(0, -answer.length).trim()
      : point.lead.trim();
    if (!lead || !answer) throw new ApiError(502, `第 ${index + 1} 个知识点缺少 lead 或 answer`);
    return {
      id: `point-${index + 1}`,
      lead,
      answer,
      answerPosition: "line_end" as const,
      minAnswerWindowMs: policy.window[0],
      maxAnswerWindowMs: policy.window[1],
      cue: point.cue || "接唱",
    };
  });
}

export async function createThemeSongPlan(input: unknown, signal: AbortSignal, job?: JobTracker): Promise<ThemeSongPlan> {
  const parsed = themePlanInputSchema.parse(input);
  const policy = AGE_POLICIES[parsed.ageBand];
  const plan = await requestKnowledgePlan(parsed, policy, signal, job);
  const tuning = TUNING_PRESETS[parsed.tuning];
  const positiveStyle = [...new Set([...tuning.positive, ...plan.styleTags, ...policy.positiveStyle, ...STYLE_BY_SCENE[parsed.scene]])]
    .filter((style) => !tuning.stripPositive.some((term) => style.toLowerCase().includes(term)))
    .slice(0, 30);
  const negativeStyle = [...new Set([...plan.avoidTags, ...tuning.negative, ...policy.negativeStyle])].slice(0, 30);
  const briefZh = [plan.musicZh, tuning.briefZh].filter(Boolean).join("\n").slice(0, 400);
  const briefEn = [plan.musicEn, tuning.briefEn].filter(Boolean).join(" ").slice(0, 400);
  const points = sanitizePoints(plan, policy);
  const excerpt = parsed.sourceNotes || [
    `主题：${parsed.theme}`,
    `人工确认前的 AI 辅助摘要：${plan.summary}`,
    ...points.map((point) => `${point.lead}${point.answer}`),
  ].join("\n");
  const sectionTypes = SECTION_PATTERN_BY_TUNING[parsed.tuning];
  const sectionCounts = new Map<string, number>();
  let remainingSec = policy.durationSec;
  const sections = sectionTypes.map((type, index) => {
    const sequence = (sectionCounts.get(type) ?? 0) + 1;
    sectionCounts.set(type, sequence);
    const slots = sectionTypes.length - index;
    const targetSec = Math.max(3, Math.round(remainingSec / slots));
    remainingSec -= targetSec;
    return { id: `${type.replaceAll("_", "-")}-${sequence}`, type, targetSec };
  });
  const [minimumBpm, maximumBpm] = BPM_RANGE_BY_TUNING[parsed.tuning];
  const bpm = Math.min(maximumBpm, Math.max(minimumBpm, BPM_BY_SCENE[parsed.scene][parsed.ageBand]));
  const key = MUSICAL_KEYS[stableVariantIndex(`${parsed.theme}|${parsed.ageBand}|${parsed.scene}|${parsed.tuning}`, MUSICAL_KEYS.length)];
  const content: SongSpecContent = songSpecContentSchema.parse({
    schemaVersion: 1,
    title: plan.title,
    language: "zh-CN",
    domain: plan.domain,
    audience: policy.audience,
    scene: parsed.scene,
    hook: plan.hook,
    notes: "由 AI 辅助拆解主题；管理员确认知识内容后，方可批准规格并生成候选。",
    source: {
      type: parsed.sourceNotes ? "editorial-reference" : "ai-assisted-editorial-draft",
      title: `主题资料：${parsed.theme}`,
      version: new Date().toISOString().slice(0, 10),
      license: "internal",
      excerpt,
      sourceHash: sha256(excerpt),
    },
    learning: {
      objective: plan.objective,
      retrievalMode: "sentence-final-answer",
      prerequisites: plan.prerequisites,
      contentRisk: plan.contentRisk,
    },
    lyrics: {
      style: { id: parsed.lyricStyle, version: 1 },
      coreMemoryLine: plan.hook,
      logicLinks: plan.logicLinks
        .filter((link) => points[link.fromIndex] && points[link.toIndex])
        .map((link) => ({
          fromPointId: points[link.fromIndex].id,
          toPointId: points[link.toIndex].id,
          relation: link.relation,
          connector: link.connector,
        })),
    },
    music: {
      tuning: { id: parsed.tuning, version: 1 },
      durationSec: policy.durationSec,
      bpm,
      key,
      lowestNote: policy.lowestNote,
      highestNote: policy.highestNote,
      voice: policy.voice,
      positiveStyle,
      negativeStyle,
      brief: briefEn || briefZh ? { zh: briefZh, en: briefEn } : undefined,
    },
    sections,
    points,
    generation: {
      requiredOutputs: ["mixed"],
      seedPolicy: "record-required",
      providerPolicy: "batch-compare",
    },
  });
  const ageLabel = THEME_AGE_BAND_ITEMS.find((item) => item.value === parsed.ageBand)?.label ?? parsed.ageBand;
  const knowledgePoints = points.map(({ lead, answer, cue }) => ({ lead, answer, cue }));
  const lyrics = buildSongSpecLyrics(content);
  const lyricAssessment = evaluateLyricStructure(content, lyrics);
  const prompt = buildSongSpecPrompt(content);

  job?.artifact("拆解", "points", "知识点与句尾答案", { points: knowledgePoints });
  job?.step(`按规格生成歌词，共 ${lyrics.split("\n").filter(Boolean).length} 行`);
  job?.artifact("歌词", "text", "自动生成歌词", { text: lyrics, language: content.language });
  job?.artifact("歌词评测", "fields", lyricAssessment.passed ? "歌词结构门禁通过" : "歌词结构需要人工复核", {
    fields: [
      { label: "总分", value: String(lyricAssessment.total) },
      ...lyricAssessment.dimensions.map((dimension) => ({ label: dimension.label, value: `${dimension.score}/${dimension.threshold} · ${dimension.verdict === "pass" ? "通过" : "待改"}` })),
    ],
  });
  job?.step("按年龄、场景与调优策略生成音乐提示词");
  if (content.music.brief?.zh) {
    job?.artifact("提示词", "text", "编曲设想（中文，给运营看）", { text: content.music.brief.zh });
  }
  job?.artifact("提示词", "text", "音乐模型提示词（英文，发给模型）", { text: prompt });
  job?.artifact("提示词", "fields", "音乐参数", {
    fields: [
      { label: "时长", value: `${content.music.durationSec} 秒` },
      { label: "BPM", value: String(content.music.bpm) },
      { label: "调性", value: content.music.key },
      { label: "音域", value: `${content.music.lowestNote}–${content.music.highestNote}` },
      { label: "声线", value: content.music.voice },
      { label: "调优", value: THEME_TUNING_ITEMS.find((item) => item.value === parsed.tuning)?.label ?? parsed.tuning },
      { label: "结构", value: content.sections.map((section) => `${section.type} ${section.targetSec}s`).join(" · ") },
    ],
  });

  return {
    theme: parsed.theme,
    ageBand: parsed.ageBand,
    ageLabel,
    scene: parsed.scene,
    tuning: parsed.tuning,
    lyricStyle: parsed.lyricStyle,
    summary: plan.summary,
    knowledgePoints,
    lyrics,
    prompt,
    songSpec: {
      specKey: `${plan.slug}-${randomUUID().slice(0, 8)}`,
      content,
    },
  };
}
