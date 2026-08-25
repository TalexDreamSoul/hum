import "server-only";

import {
  executePipelinePlan,
  listRunnablePipelinePlanIds,
  runDuePipelineSchedules,
} from "./pipelines";

export async function collectPipelineSchedulerWork(userId: string | null, limit = 20) {
  const createdPlanIds = await runDuePipelineSchedules(userId, limit);
  const runnableIds = await listRunnablePipelinePlanIds(limit);
  return {
    createdPlanIds,
    planIds: [...new Set([...createdPlanIds, ...runnableIds])],
  };
}

export async function runPipelineSchedulerTick(userId: string | null = null, limit = 20) {
  const work = await collectPipelineSchedulerWork(userId, limit);
  const results = await Promise.allSettled(work.planIds.map((planId) => executePipelinePlan(planId)));
  return {
    created: work.createdPlanIds.length,
    attempted: work.planIds.length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}
