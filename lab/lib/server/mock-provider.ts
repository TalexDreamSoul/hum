import "server-only";

import { createHash } from "node:crypto";

export const MOCK_ENABLED = true as const;
export const MOCK_PROVIDER = "mock" as const;
export const MOCK_MUSIC_MODEL = "music-3.0-free" as const;
export const MOCK_REQUESTS_PER_MINUTE = 3 as const;

export interface MockMarker {
  mock: true;
  provider: typeof MOCK_PROVIDER;
}

export function mockMarker(): MockMarker {
  return { mock: true, provider: MOCK_PROVIDER };
}

export function mockHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface MockKnowledgeExpansion {
  slug: string;
  title: string;
  domain: string;
  objective: string;
  hook: string;
  summary: string;
  prerequisites: string[];
  contentRisk: "low" | "medium" | "high";
  musicZh: string;
  musicEn: string;
  styleTags: string[];
  avoidTags: string[];
  points: Array<{ lead: string; answer: string; cue: string }>;
  logicLinks: Array<{
    fromIndex: number;
    toIndex: number;
    relation: "sequence" | "cause" | "contrast" | "classification" | "condition" | "result";
    connector: string;
  }>;
  mock: true;
  provider: typeof MOCK_PROVIDER;
}

/**
 * A deliberately conservative expansion: it teaches a reusable learning loop instead of
 * inventing facts about an arbitrary topic. It is deterministic and always remains subject
 * to the existing human knowledge and SongSpec approval gates.
 */
export function createMockKnowledgeExpansion(input: { theme: string; maxPoints?: number }): MockKnowledgeExpansion {
  const theme = input.theme.trim().replace(/\s+/g, " ").slice(0, 80) || "这个主题";
  const pointCount = Math.max(3, Math.min(input.maxPoints ?? 5, 5));
  const allPoints = [
    { lead: `认识${theme}，先从`, answer: "观察开始", cue: "接唱" },
    { lead: "观察以后，要把", answer: "重点记牢", cue: "接唱" },
    { lead: "遇到问题时，可以", answer: "一步一步想", cue: "接唱" },
    { lead: "学完以后，用自己的话", answer: "说出来", cue: "接唱" },
    { lead: "每天复习一点点，知识会", answer: "记更牢", cue: "接唱" },
  ].slice(0, pointCount);
  const relations: MockKnowledgeExpansion["logicLinks"][number]["relation"][] = ["sequence", "condition", "cause", "result"];

  return {
    slug: `mock-${mockHash(theme).slice(0, 12)}`,
    title: `${theme}小小知识歌`,
    domain: "通识学习",
    objective: `通过观察、梳理、表达和复习，建立关于“${theme}”的可复述学习框架。`,
    hook: `${theme}记心间`,
    summary: `这是 Mock provider 为“${theme}”生成的可人工复核学习框架；不包含未经核验的主题事实。`,
    prerequisites: [],
    contentRisk: "low",
    musicZh: "明亮、清晰、节奏稳定的儿童学习歌曲；每个句尾留出可接唱空间，避免无词人声。",
    musicEn: "bright child-friendly learning pop, clear lead vocal range, gentle rhythm, sentence-final recall gaps, no wordless vocalise",
    styleTags: ["children-pop", "clear-vocal", "gentle-rhythm"],
    avoidTags: ["humming", "wordless-vocalise", "harsh-bass"],
    points: allPoints,
    logicLinks: allPoints.slice(1).map((_, index) => ({
      fromIndex: index,
      toIndex: index + 1,
      relation: relations[index] ?? "sequence",
      connector: index === 0 ? "接着" : index === 1 ? "遇到问题时" : "最后",
    })),
    ...mockMarker(),
  };
}
