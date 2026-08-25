import type { SongSpecContent } from "./song-spec";

export const THEME_AGE_BAND_ITEMS = [
  { value: "3-4", label: "3–4 岁" },
  { value: "5-6", label: "5–6 岁" },
  { value: "7-8", label: "7–8 岁" },
  { value: "9-12", label: "9–12 岁" },
] as const;

export const THEME_SCENE_ITEMS = [
  { value: "general", label: "通用（不绑场景）" },
  { value: "morning", label: "晨间" },
  { value: "bath", label: "洗漱" },
  { value: "commute", label: "通勤车程" },
  { value: "meal", label: "用餐" },
  { value: "play", label: "玩耍" },
  { value: "focus", label: "专注复习" },
  { value: "travel", label: "长途出行" },
  { value: "bedtime", label: "睡前" },
] as const;

export const THEME_TUNING_ITEMS = [
  { value: "general", label: "通用", description: "保留按年龄和场景生成的平衡风格。" },
  { value: "strong", label: "强化", description: "弱化电音，强化四句钩子、主唱前置和一听能跟唱。" },
  { value: "earworm", label: "洗脑", description: "三到七字记忆句高频回归；直接唱词，不用哼哼啊啦填充。" },
  { value: "rock", label: "摇滚", description: "明亮流行摇滚、真鼓和清晰吉他；有力量但不吼叫。" },
  { value: "jazz", label: "爵士", description: "钢琴、低音提琴与轻刷鼓；旋律舒展，但不使用无词即兴。" },
  { value: "folk", label: "民谣", description: "木吉他与自然人声，叙述感清楚、节奏稳定。" },
  { value: "trendy", label: "潮流", description: "当代流行律动与精简制作，不模仿具体艺人或热歌。" },
  { value: "rap", label: "说唱", description: "清楚押拍的短句主歌配可唱副歌，避免含混快嘴与攻击性。" },
  { value: "acoustic", label: "原声", description: "木吉他、钢琴和轻打击乐，减少合成器音色。" },
  { value: "singalong", label: "接唱", description: "短问短答、重复副歌和清楚停顿，方便孩子接唱。" },
  { value: "gentle", label: "轻柔", description: "更低密度、更温暖，适合睡前和安静场景。" },
  { value: "body-groove", label: "律动", description: "拍手、跺脚和身体打击乐，强化节拍记忆。" },
] as const;

export const THEME_TUNING_VALUES = THEME_TUNING_ITEMS.map((item) => item.value) as [
  "general", "strong", "earworm", "rock", "jazz", "folk", "trendy", "rap",
  "acoustic", "singalong", "gentle", "body-groove",
];

export type ThemeAgeBand = typeof THEME_AGE_BAND_ITEMS[number]["value"];
export type ThemeScene = typeof THEME_SCENE_ITEMS[number]["value"];
export type ThemeTuning = typeof THEME_TUNING_ITEMS[number]["value"];

export const THEME_LYRIC_STYLE_ITEMS = [
  { value: "general", label: "通用", description: "用清楚的知识链和短副歌组织内容。" },
  { value: "narrative", label: "叙事", description: "按场景、变化和结论推进，适合过程类主题。" },
  { value: "mnemonic", label: "记忆钩子", description: "核心句前置并多次回归，答案随回归轮换。" },
  { value: "call-response", label: "问答接唱", description: "短问短答，答案留在句尾并保留接唱空间。" },
] as const;

export const THEME_LYRIC_STYLE_VALUES = THEME_LYRIC_STYLE_ITEMS.map((item) => item.value) as [
  "general", "narrative", "mnemonic", "call-response",
];

export type ThemeLyricStyle = typeof THEME_LYRIC_STYLE_ITEMS[number]["value"];

export const THEME_AGE_DURATION_SEC: Record<ThemeAgeBand, number> = {
  "3-4": 45,
  "5-6": 60,
  "7-8": 75,
  "9-12": 90,
};

export interface ThemeSongPlan {
  theme: string;
  ageBand: ThemeAgeBand;
  ageLabel: string;
  scene: ThemeScene;
  summary: string;
  tuning: ThemeTuning;
  lyricStyle: ThemeLyricStyle;
  knowledgePoints: Array<{ lead: string; answer: string; cue: string }>;
  /** 由规格确定性生成，生成候选时原样发给音乐模型，先给人看一眼。 */
  lyrics: string;
  prompt: string;
  songSpec: {
    specKey: string;
    content: SongSpecContent;
  };
}
