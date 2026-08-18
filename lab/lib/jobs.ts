/** 任务队列的共享类型与文案：服务端写入，后台页面读取。 */

export const JOB_KINDS = ["production_run", "theme_plan", "experiment_batch", "music_test", "provider_test", "song_analysis"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = "running" | "succeeded" | "failed";

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  production_run: "主题创作",
  theme_plan: "主题拆解",
  experiment_batch: "候选生成",
  music_test: "模型测试",
  provider_test: "连通性测试",
  song_analysis: "歌曲分析",
};

export interface JobStep {
  at: number;
  message: string;
  detail?: string;
}

/**
 * 任务产物：每个阶段留下的可视化结果，页面按 kind 决定怎么渲染，
 * 不再把 JSON 原文丢给人看。
 */
export type JobArtifactKind = "fields" | "points" | "text" | "audio" | "scores";

export interface JobArtifact {
  stage: string;
  kind: JobArtifactKind;
  title: string;
  data: unknown;
}

export interface JobFieldsData {
  fields: Array<{ label: string; value: string }>;
}

export interface JobPointsData {
  points: Array<{ lead: string; answer: string; cue: string }>;
}

export interface JobTextData {
  text: string;
  language?: string;
}

export interface JobAudioData {
  url: string;
  label: string;
}

export interface JobScoresData {
  total: number | null;
  grade: string | null;
  threshold: number;
  passed: boolean;
  dims: Array<{ label: string; score: number | null; detail: string }>;
}

/** 一条流水线里每个环节的状态；没跑到的环节也要显示，并说明卡在哪。 */
export type JobStageStatus = "done" | "running" | "waiting" | "failed" | "blocked" | "pending";

export interface JobStageView {
  stage: string;
  status: JobStageStatus;
  note?: string;
}

export const JOB_STAGE_STATUS_LABELS: Record<JobStageStatus, string> = {
  done: "已完成",
  running: "进行中",
  waiting: "待确认",
  failed: "失败",
  blocked: "卡住",
  pending: "待执行",
};

export interface JobRecord {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  actorUserId: string | null;
  actorName: string | null;
  parentJobId: string | null;
  rootJobId: string;
  input: unknown;
  steps: JobStep[];
  artifacts: JobArtifact[];
  output: unknown;
  error: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  durationMs: number;
}
