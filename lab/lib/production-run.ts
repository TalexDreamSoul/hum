export const PRODUCTION_RUN_PHASES = [
  "queued_plan",
  "running_plan",
  "waiting_plan",
  "queued_approval",
  "running_approval",
  "waiting_generation",
  "queued_generation",
  "running_generation",
  "complete",
] as const;

export type ProductionRunPhase = (typeof PRODUCTION_RUN_PHASES)[number];

export interface ProductionRunState {
  phase: ProductionRunPhase;
  manualConfirmation: boolean;
  specId?: string;
  batchId?: string;
  candidateIds?: string[];
  knowledgeConfirmedBy?: string;
  generationConfirmedBy?: string;
}

export interface ProductionRunConfirmation {
  stage: "人工确认" | "生成";
  action: string;
  description: string;
}

export function productionRunStateOf(value: unknown): ProductionRunState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<ProductionRunState>;
  if (!PRODUCTION_RUN_PHASES.some((phase) => phase === state.phase)) return null;
  if (typeof state.manualConfirmation !== "boolean") return null;
  return state as ProductionRunState;
}

export function productionRunConfirmation(state: ProductionRunState | null): ProductionRunConfirmation | null {
  if (state?.phase === "waiting_plan") {
    return {
      stage: "人工确认",
      action: "确认知识内容并继续",
      description: "请核对学习目标、知识点、句尾答案和歌词。确认后才会批准不可变 SongSpec。",
    };
  }
  if (state?.phase === "waiting_generation") {
    return {
      stage: "生成",
      action: "确认并开始生成候选",
      description: "SongSpec 已批准。确认后会调用 MiniMax，候选落入隔离区并自动评分。",
    };
  }
  return null;
}

export function isProductionRunWaiting(value: unknown): boolean {
  return productionRunConfirmation(productionRunStateOf(value)) !== null;
}
