import "server-only";

import { randomUUID } from "node:crypto";
import type { JobArtifact, JobArtifactKind, JobKind, JobRecord, JobStatus, JobStep } from "../jobs";
import { getDb } from "./database";
import { dispatchPendingNotifications, enqueueNotificationEvent, type NotificationEvent } from "./notifications";

/**
 * 任务队列：长耗时的服务端动作（AI 拆解、MiniMax 生成、模型测试）在这里留痕。
 * 请求本身仍是同步的，队列负责记录每一步、耗时、输出和失败原因，方便事后追。
 */

export type { JobArtifact, JobKind, JobRecord, JobStageView, JobStatus, JobStep } from "../jobs";

export interface JobTracker {
  id: string;
  /** 记录一步进展；detail 里可以放上游返回、模型名这类排查用的信息。 */
  step(message: string, detail?: unknown): void;
  /** 记录一个阶段产物：知识点、歌词、提示词、音频、评分都走这里，页面按 kind 渲染。 */
  artifact(stage: string, kind: JobArtifactKind, title: string, data: unknown): void;
  /** 任务成功后展示在详情里的结构化输出。 */
  setOutput(value: unknown): void;
}

async function publishJobNotification(input: {
  id: string;
  title: string;
  event: NotificationEvent;
  status: string;
  detail?: string;
  keySuffix: string;
}): Promise<void> {
  try {
    await enqueueNotificationEvent(getDb(), `job:${input.id}:${input.keySuffix}`, input.event, {
      title: input.title,
      status: input.status,
      detail: input.detail,
      subjectId: input.id,
      path: "/console/jobs",
    });
    await dispatchPendingNotifications();
  } catch {
    // 业务任务终态已落库；通知失败由 outbox 重试，不反向污染任务结果。
  }
}

const MAX_TEXT = 4000;

function shrink(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > MAX_TEXT ? { truncated: true, preview: text.slice(0, MAX_TEXT) } : JSON.parse(text);
}

function detailText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function rowToJob(row: {
  id: string; kind: string; title: string; status: string; actor_user_id: string | null; actor_name: string | null;
  parent_job_id: string | null; root_job_id: string | null;
  input_json: string; steps_json: string; artifacts_json: string; output_json: string; error: string;
  created_at: number; updated_at: number; finished_at: number | null;
}): JobRecord {
  const parse = (text: string, fallback: unknown) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };
  return {
    id: row.id,
    kind: row.kind as JobKind,
    title: row.title,
    status: row.status as JobStatus,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    parentJobId: row.parent_job_id,
    rootJobId: row.root_job_id ?? row.id,
    input: parse(row.input_json, {}),
    steps: parse(row.steps_json, []) as JobStep[],
    artifacts: parse(row.artifacts_json, []) as JobArtifact[],
    output: parse(row.output_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    durationMs: (row.finished_at ?? Date.now()) - row.created_at,
  };
}

const SELECT_JOB = `
  SELECT j.id, j.kind, j.title, j.status, j.actor_user_id, u.display_name AS actor_name,
         j.parent_job_id, j.root_job_id, j.input_json, j.steps_json, j.artifacts_json, j.output_json, j.error, j.created_at, j.updated_at, j.finished_at
  FROM jobs j LEFT JOIN users u ON u.id = j.actor_user_id
`;

export interface JobPage {
  jobs: JobRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listJobs(page = 1, pageSize = 20, kind?: JobKind) {
  const db = getDb();
  const size = Math.min(Math.max(pageSize, 1), 100);
  const where = kind ? "WHERE j.kind = ?" : "";
  const params = kind ? [kind] : [];
  const total = kind
    ? await db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = ?").pluck().get(kind) as number
    : await db.prepare("SELECT COUNT(*) FROM jobs").pluck().get() as number;
  const current = Math.min(Math.max(page, 1), Math.max(1, Math.ceil(total / size)));
  const rows = await db.prepare(`${SELECT_JOB} ${where} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).all(...params, size, (current - 1) * size) as never[];
  return { jobs: rows.map(rowToJob), total, page: current, pageSize: size };
}

export async function getJob(id: string) {
  const row = await getDb().prepare(`${SELECT_JOB} WHERE j.id = ?`).get(id) as never | undefined;
  return row ? rowToJob(row) : null;
}

/** 同一条重试链上的所有运行，按时间正序，作为版本历史。 */
export async function listJobRuns(rootId: string) {
  const rows = await getDb().prepare(`${SELECT_JOB} WHERE COALESCE(j.root_job_id, j.id) = ? ORDER BY j.created_at ASC LIMIT 50`).all(rootId) as never[];
  return rows.map(rowToJob);
}

/**
 * 包住一次长耗时动作：开始即入队并可见，过程中的 step 实时写库，
 * 成功写 output，失败写 error，两种情况都记录耗时。
 */
export interface TrackedJobContinuation<T> {
  value: T;
  complete: boolean;
}

const activeTrackedJobs = new Set<string>();

export async function createTrackedJob(meta: {
  kind: JobKind;
  title: string;
  userId: string;
  input: unknown;
  output: unknown;
}) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  await db.prepare(`
    INSERT INTO jobs (id, kind, title, status, actor_user_id, parent_job_id, root_job_id, input_json, steps_json, artifacts_json, output_json, error, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, NULL, ?, ?, '[]', '[]', ?, '', ?, ?)
  `).run(id,
  meta.kind,
  meta.title.slice(0, 200),
  meta.userId,
  id,
  JSON.stringify(meta.input ?? {}),
  JSON.stringify(meta.output ?? null),
  now,
  now,);
  const job = await getJob(id);
  if (!job) throw new Error("任务创建后未找到");
  return job;
}

export async function setTrackedJobOutput(id: string, output: unknown) {
  const result = await getDb().prepare("UPDATE jobs SET output_json = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(output ?? null), Date.now(), id);
  if (result.changes !== 1) throw new Error("任务不存在或已经结束");
}

export async function continueTrackedJob<T>(
  id: string,
  run: (tracker: JobTracker, job: JobRecord) => Promise<TrackedJobContinuation<T>>,
): Promise<T | null> {
  if (activeTrackedJobs.has(id)) return null;
  const job = await getJob(id);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "running") throw new Error("任务已经结束");

  activeTrackedJobs.add(id);
  const db = getDb();
  const steps = [...job.steps];
  const artifacts = [...job.artifacts];
  let output = job.output;
  let persistence = Promise.resolve();
  const flush = () => {
    const snapshot = [JSON.stringify(steps), JSON.stringify(artifacts), JSON.stringify(output), Date.now(), id] as const;
    persistence = persistence.then(async () => {
      await db.prepare("UPDATE jobs SET steps_json = ?, artifacts_json = ?, output_json = ?, updated_at = ? WHERE id = ?").run(...snapshot);
    });
    return persistence;
  };
  const tracker: JobTracker = {
    id,
    step(message, detail) {
      steps.push({ at: Date.now(), message: message.slice(0, 200), detail: detailText(detail) });
      void flush();
    },
    artifact(stage, kind, title, data) {
      artifacts.push({ stage, kind, title, data: shrink(data) });
      void flush();
    },
    setOutput(value) {
      output = value ?? null;
      void flush();
    },
  };

  try {
    const continuation = await run(tracker, job);
    await persistence;
    const now = Date.now();
    if (continuation.complete) {
      await db.prepare("UPDATE jobs SET status = 'succeeded', output_json = ?, steps_json = ?, artifacts_json = ?, error = '', updated_at = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(output), JSON.stringify(steps), JSON.stringify(artifacts), now, now, id);
    } else {
      await db.prepare("UPDATE jobs SET output_json = ?, steps_json = ?, artifacts_json = ?, error = '', updated_at = ?, finished_at = NULL WHERE id = ?").run(JSON.stringify(output), JSON.stringify(steps), JSON.stringify(artifacts), now, id);
    }
    let phase = "";
    if (typeof output === "object" && output && "phase" in output && typeof output.phase === "string") phase = output.phase;
    if (continuation.complete) {
      await publishJobNotification({ id, title: job.title, event: "job.completed", status: "已完成", detail: steps.at(-1)?.message, keySuffix: "completed" });
    } else if (phase.startsWith("waiting")) {
      await publishJobNotification({ id, title: job.title, event: "job.waiting", status: "待人工确认", detail: steps.at(-1)?.message, keySuffix: phase });
    }
    return continuation.value;
  } catch (error) {
    await persistence.catch(() => undefined);
    const now = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare("UPDATE jobs SET status = 'failed', error = ?, output_json = ?, steps_json = ?, artifacts_json = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(message.slice(0, 600), JSON.stringify(output), JSON.stringify(steps), JSON.stringify(artifacts), now, now, id);
    await publishJobNotification({ id, title: job.title, event: "job.failed", status: "执行失败", detail: message, keySuffix: "failed" });
    throw error;
  } finally {
    activeTrackedJobs.delete(id);
  }
}

/**
 * 包住一次长耗时动作：开始即入队并可见，过程中的 step 实时写库，
 * 成功写 output，失败写 error，两种情况都记录耗时。
 */
export async function runTrackedJob<T>(
  meta: { kind: JobKind; title: string; userId: string; input?: unknown; parentJobId?: string; rootJobId?: string },
  run: (job: JobTracker) => Promise<T>,
): Promise<T> {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  await db.prepare(`
    INSERT INTO jobs (id, kind, title, status, actor_user_id, parent_job_id, root_job_id, input_json, steps_json, artifacts_json, output_json, error, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '[]', '[]', 'null', '', ?, ?)
  `).run(id, meta.kind, meta.title.slice(0, 200), meta.userId,
    meta.parentJobId ?? null, meta.rootJobId ?? id,
    JSON.stringify(shrink(meta.input) ?? {}), now, now);

  const steps: JobStep[] = [];
  const artifacts: JobArtifact[] = [];
  let output: unknown = null;
  let persistence = Promise.resolve();
  const writeProgress = db.prepare("UPDATE jobs SET steps_json = ?, artifacts_json = ?, updated_at = ? WHERE id = ?");
  const flush = () => {
    const snapshot = [JSON.stringify(steps), JSON.stringify(artifacts), Date.now(), id] as const;
    persistence = persistence.then(async () => {
      await writeProgress.run(...snapshot);
    });
    return persistence;
  };
  const tracker: JobTracker = {
    id,
    step(message, detail) {
      steps.push({ at: Date.now(), message: message.slice(0, 200), detail: detailText(detail) });
      void flush();
    },
    artifact(stage, kind, title, data) {
      artifacts.push({ stage, kind, title, data: shrink(data) });
      void flush();
    },
    setOutput(value) {
      output = shrink(value);
    },
  };

  try {
    const result = await run(tracker);
    await persistence;
    const finished = Date.now();
    await db.prepare("UPDATE jobs SET status = 'succeeded', output_json = ?, steps_json = ?, artifacts_json = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(output), JSON.stringify(steps), JSON.stringify(artifacts), finished, finished, id);
    await publishJobNotification({ id, title: meta.title, event: "job.completed", status: "已完成", detail: steps.at(-1)?.message, keySuffix: "completed" });
    return result;
  } catch (error) {
    await persistence.catch(() => undefined);
    const finished = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare("UPDATE jobs SET status = 'failed', error = ?, output_json = ?, steps_json = ?, artifacts_json = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(message.slice(0, 600), JSON.stringify(output), JSON.stringify(steps), JSON.stringify(artifacts), finished, finished, id);
    await publishJobNotification({ id, title: meta.title, event: "job.failed", status: "执行失败", detail: message, keySuffix: "failed" });
    throw error;
  }
}
