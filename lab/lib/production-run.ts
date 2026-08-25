export const PRODUCTION_RUN_PHASES = [
  "queued_plan",
  "running_plan",
  "waiting_plan",
  "queued_approval",
  "running_approval",
  "waiting_approval",
  "waiting_generation",
  "queued_generation",
  "waiting_human_review",
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
  approvalConfirmedBy?: string;
  generationConfirmedBy?: string;
  humanReviewConfirmedBy?: string;
  humanReviewConfirmedAt?: number;
}

export interface ProductionRunConfirmation {
  stage: "人工确认" | "生成" | "人工评审";
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
      action: "确认知识内容并提交审核",
      description: "请核对学习目标、知识点、句尾答案和歌词。此操作只会提交 SongSpec 到 spec_review，不会自动批准。",
    };
  }
  if (state?.phase === "waiting_approval") {
    return {
      stage: "人工确认",
      action: "管理员批准 SongSpec",
      description: "知识内容已确认并处于 spec_review。管理员必须显式批准后，候选生成才可能继续。",
    };
  }
  if (state?.phase === "waiting_generation") {
    return {
      stage: "生成",
      action: "确认并开始生成候选",
      description: "SongSpec 已由管理员批准。确认后会调用 Mock provider，候选落入隔离区并自动评分。",
    };
  }
  if (state?.phase === "waiting_human_review") {
    return {
      stage: "人工评审",
      action: "确认已完成人工复审",
      description: "候选已完成自动评分。管理员必须显式记录人工复审检查点；此操作不会批准母带或发布内容。",
    };
  }
  return null;
}

export function isProductionRunWaiting(value: unknown): boolean {
  return productionRunConfirmation(productionRunStateOf(value)) !== null;
}
