type SchedulerGlobal = typeof globalThis & {
  humPipelineSchedulerStarted?: boolean;
  humPipelineSchedulerRunning?: boolean;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.HUM_PIPELINE_SCHEDULER === "disabled") return;
  const schedulerGlobal = globalThis as SchedulerGlobal;
  if (schedulerGlobal.humPipelineSchedulerStarted) return;
  schedulerGlobal.humPipelineSchedulerStarted = true;

  const tick = async () => {
    if (schedulerGlobal.humPipelineSchedulerRunning) return;
    schedulerGlobal.humPipelineSchedulerRunning = true;
    try {
      const { runPipelineSchedulerTick } = await import("@/lib/server/pipeline-scheduler");
      await runPipelineSchedulerTick(null, 20);
    } catch (error) {
      console.error("流水线后台调度失败", error);
    } finally {
      schedulerGlobal.humPipelineSchedulerRunning = false;
    }
  };

  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}
