import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { recordAudit } from "./auth";
import { getDb, type HumDatabase } from "./database";
import {
  MOCK_MUSIC_MODEL,
  MOCK_PROVIDER,
  MOCK_REQUESTS_PER_MINUTE,
  createMockKnowledgeExpansion,
  mockMarker,
} from "./mock-provider";
import { generateMiniMaxMusic, reserveMiniMaxRateLimit } from "./minimax";

export const PIPELINE_STAGE_KEYS = [
  "knowledge_expand",
  "song_generate",
  "media_analyze",
  "human_review",
  "notify",
] as const;

export const PIPELINE_PLAN_STATUSES = [
  "draft",
  "queued",
  "running",
  "paused",
  "retry_wait",
  "awaiting_review",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];
export type PipelinePlanStatus = (typeof PIPELINE_PLAN_STATUSES)[number];

export const DEFAULT_PIPELINE_STAGES: Array<{ key: PipelineStageKey; label: string }> = [
  { key: "knowledge_expand", label: "知识扩写" },
  { key: "song_generate", label: "免费候选" },
  { key: "media_analyze", label: "媒体评分" },
  { key: "human_review", label: "人工复审" },
  { key: "notify", label: "进度通知" },
];

const STAGE_ORDER: Record<PipelineStageKey, number> = {
  knowledge_expand: 0,
  song_generate: 1,
  media_analyze: 2,
  human_review: 3,
  notify: 4,
};
const idSchema = z.string().trim().min(1).max(160);
const jsonRecordSchema = z.record(z.string().max(120), z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 24_000,
  "输入不能超过 24KB",
);
const pipelineStageSchema = z.object({
  key: z.enum(PIPELINE_STAGE_KEYS),
  label: z.string().trim().min(1).max(80),
}).strict();
const stagesSchema = z.array(pipelineStageSchema)
  .min(DEFAULT_PIPELINE_STAGES.length, "生产模板必须保留全部标准阶段")
  .max(DEFAULT_PIPELINE_STAGES.length, "生产模板不能添加非标准阶段")
  .superRefine((stages, context) => {
    for (const [index, expected] of DEFAULT_PIPELINE_STAGES.entries()) {
      if (stages[index]?.key !== expected.key) {
        context.addIssue({
          code: "custom",
          path: [index, "key"],
          message: "生产阶段必须保留固定顺序，且不得删除或重排人工复审",
        });
      }
    }
  });

export const pipelineTemplateCreateSchema = z.object({
  templateKey: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "模板 key 只能使用小写字母、数字和连字符"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(800).default(""),
  stages: stagesSchema,
}).strict();

export const pipelineTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(800).optional(),
  status: z.enum(["draft", "active", "retired"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段");

export const pipelineRevisionCreateSchema = z.object({ stages: stagesSchema }).strict();

export const pipelinePlanCreateSchema = z.object({
  templateRevisionId: idSchema,
  name: z.string().trim().min(1).max(160),
  subjectType: z.string().trim().min(1).max(80).default("topic"),
  subjectId: idSchema.nullable().optional(),
  input: jsonRecordSchema.default({}),
  scheduledAt: z.number().int().nonnegative().nullable().optional(),
  start: z.boolean().default(true),
}).strict();

export const pipelinePlanControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry", "approve_review"]),
  reason: z.string().trim().max(400).default(""),
}).strict();

export const pipelineScheduleCreateSchema = z.object({
  templateRevisionId: idSchema,
  name: z.string().trim().min(1).max(160),
  intervalMinutes: z.number().int().min(1).max(10_080),
  planName: z.string().trim().min(1).max(160),
  subjectType: z.string().trim().min(1).max(80).default("topic"),
  subjectId: idSchema.nullable().optional(),
  input: jsonRecordSchema.default({}),
  nextRunAt: z.number().int().nonnegative().optional(),
}).strict();

export const pipelineScheduleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(10_080).optional(),
  planName: z.string().trim().min(1).max(160).optional(),
  subjectType: z.string().trim().min(1).max(80).optional(),
  subjectId: idSchema.nullable().optional(),
  input: jsonRecordSchema.optional(),
  nextRunAt: z.number().int().nonnegative().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段");

export const pipelinePageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

interface RevisionRow {
  id: string;
  template_id: string;
  revision: number;
  stages_json: string;
  content_hash: string;
  created_by: string | null;
  created_at: number;
  template_key: string;
  template_name: string;
  template_status: "draft" | "active" | "retired";
}

interface PlanRow {
  id: string;
  template_revision_id: string;
  name: string;
  subject_type: string;
  subject_id: string | null;
  status: PipelinePlanStatus;
  input_json: string;
  output_json: string;
  mock_enabled: number;
  model: string;
  requests_per_minute: number;
  attempt: number;
  parent_plan_id: string | null;
  root_plan_id: string | null;
  scheduled_at: number | null;
  next_attempt_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  pause_reason: string;
  error: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  template_key?: string;
  template_name?: string;
  revision?: number;
}

interface StageRunRow {
  id: string;
  plan_id: string;
  stage_key: PipelineStageKey;
  position: number;
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "skipped" | "cancelled";
  checkpoint_json: string;
  artifact_hash: string;
  error: string;
  started_at: number | null;
  finished_at: number | null;
}

interface PipelineExecution {
  planId: string;
  attempt: number;
  leaseOwner: string;
  leaseExpiresAt: number;
}

interface ScheduleRow {
  id: string;
  template_revision_id: string;
  name: string;
  enabled: number;
  interval_minutes: number;
  input_json: string;
  next_run_at: number;
  last_run_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  template_key?: string;
  template_name?: string;
  revision?: number;
}

interface SchedulePayload {
  planName: string;
  subjectType: string;
  subjectId: string | null;
  input: Record<string, unknown>;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStages(value: string): Array<{ key: PipelineStageKey; label: string }> {
  const parsed = stagesSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new ApiError(409, "流水线修订的阶段定义无效");
  return parsed.data;
}

function revisionView(row: RevisionRow) {
  return {
    id: row.id,
    templateId: row.template_id,
    templateKey: row.template_key,
    templateName: row.template_name,
    templateStatus: row.template_status,
    revision: row.revision,
    stages: parseStages(row.stages_json),
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function planView(row: PlanRow) {
  return {
    id: row.id,
    templateRevisionId: row.template_revision_id,
    templateKey: row.template_key ?? "",
    templateName: row.template_name ?? "",
    revision: row.revision ?? 0,
    name: row.name,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    status: row.status,
    input: parseRecord(row.input_json),
    output: parseRecord(row.output_json),
    mockEnabled: row.mock_enabled === 1,
    provider: MOCK_PROVIDER,
    model: row.model,
    requestsPerMinute: row.requests_per_minute,
    attempt: row.attempt,
    parentPlanId: row.parent_plan_id,
    rootPlanId: row.root_plan_id,
    scheduledAt: row.scheduled_at,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    pauseReason: row.pause_reason,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function stageRunView(row: StageRunRow) {
  return {
    id: row.id,
    planId: row.plan_id,
    stageKey: row.stage_key,
    position: row.position,
    status: row.status,
    checkpoint: parseRecord(row.checkpoint_json),
    artifactHash: row.artifact_hash,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function schedulePayload(value: string): SchedulePayload {
  const parsed = z.object({
    planName: z.string().trim().min(1).max(160),
    subjectType: z.string().trim().min(1).max(80),
    subjectId: idSchema.nullable(),
    input: jsonRecordSchema,
  }).safeParse(parseRecord(value));
  if (!parsed.success) throw new ApiError(409, "计划任务保存的输入无效");
  return parsed.data;
}

function scheduleView(row: ScheduleRow) {
  const payload = schedulePayload(row.input_json);
  return {
    id: row.id,
    templateRevisionId: row.template_revision_id,
    templateKey: row.template_key ?? "",
    templateName: row.template_name ?? "",
    revision: row.revision ?? 0,
    name: row.name,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    planName: payload.planName,
    subjectType: payload.subjectType,
    subjectId: payload.subjectId,
    input: payload.input,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageBounds(page: number, pageSize: number, total: number) {
  const size = Math.min(Math.max(pageSize, 1), 100);
  const current = Math.min(Math.max(page, 1), Math.max(1, Math.ceil(total / size)));
  return { page: current, pageSize: size, offset: (current - 1) * size };
}

async function readRevision(database: HumDatabase, revisionId: string, lock = false): Promise<RevisionRow> {
  const row = await database.prepare(`
    SELECT r.*, t.template_key, t.name AS template_name, t.status AS template_status
    FROM pipeline_template_revisions r
    JOIN pipeline_templates t ON t.id = r.template_id
    WHERE r.id = ?${lock ? " FOR UPDATE" : ""}
  `).get<RevisionRow>(revisionId);
  if (!row) throw new ApiError(404, "流水线模板修订不存在");
  return row;
}

async function readPlan(database: HumDatabase, planId: string, lock = false): Promise<PlanRow> {
  const row = await database.prepare(`
    SELECT p.*, t.template_key, t.name AS template_name, r.revision
    FROM pipeline_plans p
    JOIN pipeline_template_revisions r ON r.id = p.template_revision_id
    JOIN pipeline_templates t ON t.id = r.template_id
    WHERE p.id = ?${lock ? " FOR UPDATE" : ""}
  `).get<PlanRow>(planId);
  if (!row) throw new ApiError(404, "流水线计划不存在");
  return row;
}

async function addPipelineEvent(
  database: HumDatabase,
  planId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await database.prepare(`
    INSERT INTO pipeline_events (plan_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(planId, eventType, JSON.stringify({ ...mockMarker(), ...payload }), Date.now());
}

async function insertStageRuns(
  database: HumDatabase,
  planId: string,
  stages: Array<{ key: PipelineStageKey; label: string }>,
): Promise<void> {
  const insert = database.prepare(`
    INSERT INTO pipeline_stage_runs (id, plan_id, stage_key, position, status, checkpoint_json, artifact_hash, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, 'queued', ?, '', '', NULL, NULL)
  `);
  for (const [position, stage] of stages.entries()) {
    await insert.run(randomUUID(), planId, stage.key, position, JSON.stringify({ ...mockMarker(), label: stage.label }));
  }
}

async function insertPlan(
  database: HumDatabase,
  input: {
    revision: RevisionRow;
    name: string;
    subjectType: string;
    subjectId: string | null;
    payload: Record<string, unknown>;
    createdBy: string;
    status: "draft" | "queued";
    scheduledAt: number | null;
    attempt: number;
    parentPlanId: string | null;
    rootPlanId?: string;
    scheduleId?: string;
  },
) {
  const planId = randomUUID();
  const now = Date.now();
  const rootPlanId = input.rootPlanId ?? planId;
  const output = {
    ...mockMarker(),
    templateRevisionId: input.revision.id,
    stage: input.status === "draft" ? "draft" : "queued",
    scheduleId: input.scheduleId ?? null,
  };
  await database.prepare(`
    INSERT INTO pipeline_plans (
      id, template_revision_id, name, subject_type, subject_id, status, input_json, output_json,
      mock_enabled, model, requests_per_minute, attempt, parent_plan_id, root_plan_id,
      scheduled_at, next_attempt_at, lease_owner, lease_expires_at, pause_reason, error,
      created_by, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', '', ?, ?, ?, NULL)
  `).run(
    planId,
    input.revision.id,
    input.name,
    input.subjectType,
    input.subjectId,
    input.status,
    JSON.stringify(input.payload),
    JSON.stringify(output),
    MOCK_MUSIC_MODEL,
    MOCK_REQUESTS_PER_MINUTE,
    input.attempt,
    input.parentPlanId,
    rootPlanId,
    input.scheduledAt,
    input.createdBy,
    now,
    now,
  );
  await insertStageRuns(database, planId, parseStages(input.revision.stages_json));
  await addPipelineEvent(database, planId, input.status === "draft" ? "plan.drafted" : "plan.queued", {
    templateRevisionId: input.revision.id,
    scheduleId: input.scheduleId ?? null,
    attempt: input.attempt,
  });
  return planId;
}

export async function listPipelineTemplates(page = 1, pageSize = 20) {
  const database = getDb();
  const total = await database.prepare("SELECT COUNT(*) FROM pipeline_templates").pluck().get<number>() ?? 0;
  const bounds = pageBounds(page, pageSize, total);
  const rows = await database.prepare(`
    SELECT t.*, r.id AS revision_id, r.stages_json, r.content_hash, r.created_by AS revision_created_by, r.created_at AS revision_created_at
    FROM pipeline_templates t
    JOIN pipeline_template_revisions r ON r.template_id = t.id AND r.revision = t.current_revision
    ORDER BY t.updated_at DESC, t.name ASC
    LIMIT ? OFFSET ?
  `).all<{
    id: string; template_key: string; name: string; description: string; status: "draft" | "active" | "retired";
    current_revision: number; created_by: string | null; created_at: number; updated_at: number;
    revision_id: string; stages_json: string; content_hash: string; revision_created_by: string | null; revision_created_at: number;
  }>(bounds.pageSize, bounds.offset);
  return {
    items: rows.map((row) => ({
      id: row.id,
      templateKey: row.template_key,
      name: row.name,
      description: row.description,
      status: row.status,
      currentRevision: row.current_revision,
      currentRevisionId: row.revision_id,
      stages: parseStages(row.stages_json),
      contentHash: row.content_hash,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    page: bounds.page,
    pageSize: bounds.pageSize,
    total,
  };
}

export async function getPipelineTemplate(templateId: string) {
  const database = getDb();
  const template = await database.prepare(`
    SELECT id, template_key, name, description, status, current_revision, created_by, created_at, updated_at
    FROM pipeline_templates WHERE id = ?
  `).get<{
    id: string; template_key: string; name: string; description: string; status: "draft" | "active" | "retired";
    current_revision: number; created_by: string | null; created_at: number; updated_at: number;
  }>(templateId);
  if (!template) throw new ApiError(404, "流水线模板不存在");
  const revisions = await database.prepare(`
    SELECT r.*, t.template_key, t.name AS template_name, t.status AS template_status
    FROM pipeline_template_revisions r JOIN pipeline_templates t ON t.id = r.template_id
    WHERE r.template_id = ? ORDER BY r.revision DESC
  `).all<RevisionRow>(templateId);
  return {
    id: template.id,
    templateKey: template.template_key,
    name: template.name,
    description: template.description,
    status: template.status,
    currentRevision: template.current_revision,
    createdBy: template.created_by,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    revisions: revisions.map(revisionView),
  };
}

export async function createPipelineTemplate(input: unknown, userId: string) {
  const parsed = pipelineTemplateCreateSchema.parse(input);
  const templateId = randomUUID();
  const revisionId = randomUUID();
  const now = Date.now();
  const hash = contentHash({ templateKey: parsed.templateKey, revision: 1, stages: parsed.stages });
  await getDb().transaction(async (database) => {
    await database.prepare(`
      INSERT INTO pipeline_templates (id, template_key, name, description, status, current_revision, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)
    `).run(templateId, parsed.templateKey, parsed.name, parsed.description, userId, now, now);
    await database.prepare(`
      INSERT INTO pipeline_template_revisions (id, template_id, revision, stages_json, content_hash, created_by, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(revisionId, templateId, JSON.stringify(parsed.stages), hash, userId, now);
    await recordAudit(userId, "pipeline_template.create", "pipeline_template", templateId, {
      templateKey: parsed.templateKey,
      revisionId,
      ...mockMarker(),
    }, database);
  })();
  return getPipelineTemplate(templateId);
}

export async function updatePipelineTemplate(templateId: string, input: unknown, userId: string) {
  const parsed = pipelineTemplateUpdateSchema.parse(input);
  await getDb().transaction(async (database) => {
    const current = await database.prepare("SELECT id FROM pipeline_templates WHERE id = ? FOR UPDATE").get<{ id: string }>(templateId);
    if (!current) throw new ApiError(404, "流水线模板不存在");
    const existing = await database.prepare("SELECT name, description, status FROM pipeline_templates WHERE id = ?").get<{
      name: string; description: string; status: "draft" | "active" | "retired";
    }>(templateId);
    if (!existing) throw new ApiError(404, "流水线模板不存在");
    await database.prepare(`
      UPDATE pipeline_templates SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(parsed.name ?? existing.name, parsed.description ?? existing.description, parsed.status ?? existing.status, Date.now(), templateId);
    await recordAudit(userId, "pipeline_template.update", "pipeline_template", templateId, { ...parsed, ...mockMarker() }, database);
  })();
  return getPipelineTemplate(templateId);
}

export async function deletePipelineTemplate(templateId: string, userId: string): Promise<void> {
  await getDb().transaction(async (database) => {
    const template = await database.prepare("SELECT status FROM pipeline_templates WHERE id = ? FOR UPDATE").get<{ status: string }>(templateId);
    if (!template) throw new ApiError(404, "流水线模板不存在");
    if (template.status !== "draft") throw new ApiError(409, "只有 draft 模板可以删除；已有生产记录的模板请退役");
    const result = await database.prepare("DELETE FROM pipeline_templates WHERE id = ?").run(templateId);
    if (!result.changes) throw new ApiError(409, "模板仍被修订或计划引用，不能删除");
    await recordAudit(userId, "pipeline_template.delete", "pipeline_template", templateId, { ...mockMarker() }, database);
  })();
}

export async function createPipelineTemplateRevision(templateId: string, input: unknown, userId: string) {
  const parsed = pipelineRevisionCreateSchema.parse(input);
  const revisionId = randomUUID();
  await getDb().transaction(async (database) => {
    const template = await database.prepare(`
      SELECT id, template_key, status, current_revision FROM pipeline_templates WHERE id = ? FOR UPDATE
    `).get<{ id: string; template_key: string; status: "draft" | "active" | "retired"; current_revision: number }>(templateId);
    if (!template) throw new ApiError(404, "流水线模板不存在");
    if (template.status === "retired") throw new ApiError(409, "已退役模板不能新增修订");
    const revision = template.current_revision + 1;
    const hash = contentHash({ templateId, revision, stages: parsed.stages });
    const now = Date.now();
    await database.prepare(`
      INSERT INTO pipeline_template_revisions (id, template_id, revision, stages_json, content_hash, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, templateId, revision, JSON.stringify(parsed.stages), hash, userId, now);
    await database.prepare("UPDATE pipeline_templates SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(revision, now, templateId);
    const result = { revision, hash };
    await recordAudit(userId, "pipeline_template.revise", "pipeline_template", templateId, {
      revisionId,
      revision: result.revision,
      contentHash: result.hash,
      ...mockMarker(),
    }, database);
    return result;
  })();
  const revision = await getDb().prepare(`
    SELECT r.*, t.template_key, t.name AS template_name, t.status AS template_status
    FROM pipeline_template_revisions r JOIN pipeline_templates t ON t.id = r.template_id WHERE r.id = ?
  `).get<RevisionRow>(revisionId);
  if (!revision) throw new ApiError(404, "新建修订不存在");
  return revisionView(revision);
}

export async function listPipelinePlans(page = 1, pageSize = 20) {
  const database = getDb();
  const total = await database.prepare("SELECT COUNT(*) FROM pipeline_plans").pluck().get<number>() ?? 0;
  const bounds = pageBounds(page, pageSize, total);
  const rows = await database.prepare(`
    SELECT p.*, t.template_key, t.name AS template_name, r.revision
    FROM pipeline_plans p
    JOIN pipeline_template_revisions r ON r.id = p.template_revision_id
    JOIN pipeline_templates t ON t.id = r.template_id
    ORDER BY p.updated_at DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all<PlanRow>(bounds.pageSize, bounds.offset);
  return { items: rows.map(planView), page: bounds.page, pageSize: bounds.pageSize, total };
}

export async function getPipelinePlan(planId: string) {
  const database = getDb();
  const plan = await readPlan(database, planId);
  const stages = await database.prepare(`
    SELECT id, plan_id, stage_key, position, status, checkpoint_json, artifact_hash, error, started_at, finished_at
    FROM pipeline_stage_runs WHERE plan_id = ? ORDER BY position
  `).all<StageRunRow>(planId);
  const events = await database.prepare(`
    SELECT id, event_type, payload_json, created_at FROM pipeline_events
    WHERE plan_id = ? ORDER BY id DESC LIMIT 100
  `).all<{ id: number; event_type: string; payload_json: string; created_at: number }>(planId);
  return {
    ...planView(plan),
    stages: stages.map(stageRunView),
    events: events.reverse().map((event) => ({
      id: event.id,
      eventType: event.event_type,
      payload: parseRecord(event.payload_json),
      createdAt: event.created_at,
    })),
  };
}

export async function createPipelinePlan(input: unknown, userId: string) {
  const parsed = pipelinePlanCreateSchema.parse(input);
  const planId = await getDb().transaction(async (database) => {
    const revision = await readRevision(database, parsed.templateRevisionId, true);
    if (revision.template_status !== "active") throw new ApiError(409, "只有 active 模板可以创建计划");
    const planId = await insertPlan(database, {
      revision,
      name: parsed.name,
      subjectType: parsed.subjectType,
      subjectId: parsed.subjectId ?? null,
      payload: parsed.input,
      createdBy: userId,
      status: parsed.start ? "queued" : "draft",
      scheduledAt: parsed.scheduledAt ?? null,
      attempt: 1,
      parentPlanId: null,
    });
    await recordAudit(userId, "pipeline_plan.create", "pipeline_plan", planId, {
      templateRevisionId: parsed.templateRevisionId,
      scheduledAt: parsed.scheduledAt ?? null,
      ...mockMarker(),
    }, database);
    return planId;
  })();
  return getPipelinePlan(planId);
}

async function resetPausedStages(database: HumDatabase, planId: string): Promise<void> {
  await database.prepare(`
    UPDATE pipeline_stage_runs SET status = 'queued', error = ''
    WHERE plan_id = ? AND status = 'paused'
  `).run(planId);
}

export async function controlPipelinePlan(planId: string, input: unknown, userId: string) {
  const parsed = pipelinePlanControlSchema.parse(input);
  let nextPlanId = planId;
  await getDb().transaction(async (database) => {
    const plan = await readPlan(database, planId, true);
    const now = Date.now();
    if (parsed.action === "pause") {
      if (!["queued", "running", "retry_wait"].includes(plan.status)) throw new ApiError(409, "当前计划不能暂停");
      await database.prepare(`
        UPDATE pipeline_plans SET status = 'paused', pause_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(parsed.reason, now, planId);
      await database.prepare("UPDATE pipeline_stage_runs SET status = 'paused' WHERE plan_id = ? AND status = 'running'").run(planId);
      await addPipelineEvent(database, planId, "plan.paused", { reason: parsed.reason });
      await recordAudit(userId, "pipeline_plan.pause", "pipeline_plan", planId, {
        sourcePlanId: planId,
        reason: parsed.reason,
        ...mockMarker(),
      }, database);
      return;
    }
    if (parsed.action === "resume") {
      if (!["paused", "draft"].includes(plan.status)) throw new ApiError(409, "当前计划不能恢复");
      await resetPausedStages(database, planId);
      await database.prepare(`
        UPDATE pipeline_plans SET status = 'queued', pause_reason = '', error = '', next_attempt_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(now, planId);
      await addPipelineEvent(database, planId, "plan.resumed");
      await recordAudit(userId, "pipeline_plan.resume", "pipeline_plan", planId, {
        sourcePlanId: planId,
        reason: parsed.reason,
        ...mockMarker(),
      }, database);
      return;
    }
    if (parsed.action === "cancel") {
      if (["succeeded", "failed", "cancelled"].includes(plan.status)) throw new ApiError(409, "终态计划不能取消");
      await database.prepare(`
        UPDATE pipeline_plans SET status = 'cancelling', pause_reason = ?, updated_at = ? WHERE id = ?
      `).run(parsed.reason, now, planId);
      await addPipelineEvent(database, planId, "plan.cancelling", { reason: parsed.reason });
      await recordAudit(userId, "pipeline_plan.cancel", "pipeline_plan", planId, {
        sourcePlanId: planId,
        reason: parsed.reason,
        ...mockMarker(),
      }, database);
      return;
    }
    if (parsed.action === "approve_review") {
      if (plan.status !== "awaiting_review") throw new ApiError(409, "计划当前不在人工复审阶段");
      const review = await database.prepare(`
        SELECT id, status, checkpoint_json FROM pipeline_stage_runs WHERE plan_id = ? AND stage_key = 'human_review' FOR UPDATE
      `).get<{ id: string; status: string; checkpoint_json: string }>(planId);
      if (!review) throw new ApiError(409, "计划缺少人工复审阶段");
      if (review.status !== "paused") throw new ApiError(409, "人工复审检查点当前不可批准");
      const checkpoint = { ...parseRecord(review.checkpoint_json), ...mockMarker(), approvedBy: userId, approvedAt: now, manualApproval: true };
      await database.prepare(`
        UPDATE pipeline_stage_runs SET status = 'succeeded', checkpoint_json = ?, finished_at = ?, error = '' WHERE id = ?
      `).run(JSON.stringify(checkpoint), now, review.id);
      await database.prepare(`
        UPDATE pipeline_plans SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(now, planId);
      await addPipelineEvent(database, planId, "plan.review_approved", { approvedBy: userId, manualApproval: true });
      await recordAudit(userId, "pipeline_plan.approve_review", "pipeline_plan", planId, {
        sourcePlanId: planId,
        reason: parsed.reason,
        ...mockMarker(),
      }, database);
      return;
    }
    if (!["failed", "cancelled"].includes(plan.status)) throw new ApiError(409, "只有 failed 或 cancelled 计划可以创建新尝试");
    const revision = await readRevision(database, plan.template_revision_id, true);
    const rootPlanId = plan.root_plan_id ?? plan.id;
    const maxAttempt = await database.prepare(`
      SELECT COALESCE(MAX(attempt), 0) FROM pipeline_plans WHERE root_plan_id = ? OR id = ?
    `).pluck().get<number>(rootPlanId, rootPlanId) ?? 0;
    nextPlanId = await insertPlan(database, {
      revision,
      name: `${plan.name} · 重试 ${maxAttempt + 1}`,
      subjectType: plan.subject_type,
      subjectId: plan.subject_id,
      payload: parseRecord(plan.input_json),
      createdBy: userId,
      status: "queued",
      scheduledAt: null,
      attempt: maxAttempt + 1,
      parentPlanId: plan.id,
      rootPlanId,
    });
    await addPipelineEvent(database, plan.id, "plan.retry_spawned", { childPlanId: nextPlanId, attempt: maxAttempt + 1 });
    await recordAudit(userId, "pipeline_plan.retry", "pipeline_plan", nextPlanId, {
      sourcePlanId: planId,
      reason: parsed.reason,
      ...mockMarker(),
    }, database);
  })();
  return getPipelinePlan(nextPlanId);
}

export async function listPipelineSchedules(page = 1, pageSize = 20) {
  const database = getDb();
  const total = await database.prepare("SELECT COUNT(*) FROM pipeline_schedules").pluck().get<number>() ?? 0;
  const bounds = pageBounds(page, pageSize, total);
  const rows = await database.prepare(`
    SELECT s.*, t.template_key, t.name AS template_name, r.revision
    FROM pipeline_schedules s
    JOIN pipeline_template_revisions r ON r.id = s.template_revision_id
    JOIN pipeline_templates t ON t.id = r.template_id
    ORDER BY s.next_run_at ASC, s.created_at DESC
    LIMIT ? OFFSET ?
  `).all<ScheduleRow>(bounds.pageSize, bounds.offset);
  return { items: rows.map(scheduleView), page: bounds.page, pageSize: bounds.pageSize, total };
}

async function validateScheduleRevision(database: HumDatabase, revisionId: string): Promise<RevisionRow> {
  const revision = await readRevision(database, revisionId, true);
  if (revision.template_status !== "active") throw new ApiError(409, "只有 active 模板可以创建计划任务");
  parseStages(revision.stages_json);
  return revision;
}

function schedulePayloadFromInput(input: {
  planName: string;
  subjectType: string;
  subjectId?: string | null;
  input: Record<string, unknown>;
}): SchedulePayload {
  return {
    planName: input.planName,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    input: input.input,
  };
}

export async function createPipelineSchedule(input: unknown, userId: string) {
  const parsed = pipelineScheduleCreateSchema.parse(input);
  const scheduleId = randomUUID();
  const now = Date.now();
  const nextRunAt = parsed.nextRunAt ?? now + parsed.intervalMinutes * 60_000;
  await getDb().transaction(async (database) => {
    await validateScheduleRevision(database, parsed.templateRevisionId);
    await database.prepare(`
      INSERT INTO pipeline_schedules (
        id, template_revision_id, name, enabled, interval_minutes, input_json, next_run_at, last_run_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      scheduleId,
      parsed.templateRevisionId,
      parsed.name,
      parsed.intervalMinutes,
      JSON.stringify(schedulePayloadFromInput(parsed)),
      nextRunAt,
      userId,
      now,
      now,
    );
    await recordAudit(userId, "pipeline_schedule.create", "pipeline_schedule", scheduleId, { ...mockMarker() }, database);
  })();
  const row = await getDb().prepare(`
    SELECT s.*, t.template_key, t.name AS template_name, r.revision
    FROM pipeline_schedules s JOIN pipeline_template_revisions r ON r.id = s.template_revision_id
    JOIN pipeline_templates t ON t.id = r.template_id WHERE s.id = ?
  `).get<ScheduleRow>(scheduleId);
  if (!row) throw new ApiError(404, "计划任务不存在");
  return scheduleView(row);
}

export async function updatePipelineSchedule(scheduleId: string, input: unknown, userId: string) {
  const parsed = pipelineScheduleUpdateSchema.parse(input);
  await getDb().transaction(async (database) => {
    const current = await database.prepare("SELECT * FROM pipeline_schedules WHERE id = ? FOR UPDATE").get<ScheduleRow>(scheduleId);
    if (!current) throw new ApiError(404, "计划任务不存在");
    const payload = schedulePayload(current.input_json);
    const nextPayload: SchedulePayload = {
      planName: parsed.planName ?? payload.planName,
      subjectType: parsed.subjectType ?? payload.subjectType,
      subjectId: parsed.subjectId === undefined ? payload.subjectId : parsed.subjectId,
      input: parsed.input ?? payload.input,
    };
    await database.prepare(`
      UPDATE pipeline_schedules
      SET name = ?, enabled = ?, interval_minutes = ?, input_json = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      parsed.name ?? current.name,
      parsed.enabled === undefined ? current.enabled : (parsed.enabled ? 1 : 0),
      parsed.intervalMinutes ?? current.interval_minutes,
      JSON.stringify(nextPayload),
      parsed.nextRunAt ?? current.next_run_at,
      Date.now(),
      scheduleId,
    );
    await recordAudit(userId, "pipeline_schedule.update", "pipeline_schedule", scheduleId, { ...parsed, ...mockMarker() }, database);
  })();
  const row = await getDb().prepare(`
    SELECT s.*, t.template_key, t.name AS template_name, r.revision
    FROM pipeline_schedules s JOIN pipeline_template_revisions r ON r.id = s.template_revision_id
    JOIN pipeline_templates t ON t.id = r.template_id WHERE s.id = ?
  `).get<ScheduleRow>(scheduleId);
  if (!row) throw new ApiError(404, "计划任务不存在");
  return scheduleView(row);
}

export async function deletePipelineSchedule(scheduleId: string, userId: string): Promise<void> {
  await getDb().transaction(async (database) => {
    const result = await database.prepare("DELETE FROM pipeline_schedules WHERE id = ?").run(scheduleId);
    if (!result.changes) throw new ApiError(404, "计划任务不存在");
    await recordAudit(userId, "pipeline_schedule.delete", "pipeline_schedule", scheduleId, { ...mockMarker() }, database);
  })();
}

export async function runDuePipelineSchedules(userId: string, limit = 20) {
  const now = Date.now();
  const planIds = await getDb().transaction(async (database) => {
    const dueSchedules = await database.prepare(`
      WITH due AS (
        SELECT id FROM pipeline_schedules
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ?
      )
      UPDATE pipeline_schedules AS s
      SET last_run_at = ?, next_run_at = ? + s.interval_minutes * 60000, updated_at = ?
      FROM due
      WHERE s.id = due.id
      RETURNING s.*
    `).all<ScheduleRow>(now, Math.min(Math.max(limit, 1), 100), now, now, now);
    const created: string[] = [];
    for (const schedule of dueSchedules) {
      const revision = await readRevision(database, schedule.template_revision_id, true);
      const payload = schedulePayload(schedule.input_json);
      const planId = await insertPlan(database, {
        revision,
        name: payload.planName,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        payload: payload.input,
        createdBy: userId,
        status: "queued",
        scheduledAt: null,
        attempt: 1,
        parentPlanId: null,
        scheduleId: schedule.id,
      });
      await recordAudit(userId, "pipeline_schedule.run_due", "pipeline_plan", planId, { ...mockMarker() }, database);
      created.push(planId);
    }
    return created;
  })();
  return planIds;
}

export async function listRunnablePipelinePlanIds(limit = 20): Promise<string[]> {
  const now = Date.now();
  const rows = await getDb().prepare(`
    SELECT id FROM pipeline_plans
    WHERE status IN ('queued', 'retry_wait', 'running')
      AND (status <> 'running' OR lease_expires_at <= ?)
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    ORDER BY COALESCE(scheduled_at, next_attempt_at, created_at), created_at
    LIMIT ?
  `).all<{ id: string }>(now, now, now, now, Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => row.id);
}

async function finaliseCancellation(planId: string): Promise<void> {
  await getDb().transaction(async (database) => {
    const plan = await readPlan(database, planId, true);
    if (plan.status !== "cancelling") return;
    const now = Date.now();
    await database.prepare(`
      UPDATE pipeline_stage_runs SET status = 'cancelled', finished_at = ?, error = '计划已取消'
      WHERE plan_id = ? AND status IN ('queued', 'running', 'paused')
    `).run(now, planId);
    await database.prepare(`
      UPDATE pipeline_plans SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        finished_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, planId);
    await addPipelineEvent(database, planId, "plan.cancelled");
  })();
}

async function claimPipelinePlan(planId: string, workerId: string): Promise<PlanRow | null> {
  const now = Date.now();
  const leaseExpiresAt = now + 60_000;
  const row = await getDb().prepare(`
    WITH candidate AS (
      SELECT id FROM pipeline_plans
      WHERE id = ?
        AND status IN ('queued', 'retry_wait', 'running')
        AND (status <> 'running' OR lease_expires_at <= ?)
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE pipeline_plans AS p
    SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
    FROM candidate
    WHERE p.id = candidate.id
    RETURNING p.*
  `).get<PlanRow>(planId, now, now, now, now, workerId, leaseExpiresAt, now);
  return row ?? null;
}

function pipelineExecutionFromClaim(plan: PlanRow): PipelineExecution {
  if (plan.status !== "running" || !plan.lease_owner || plan.lease_expires_at === null) {
    throw new ApiError(409, "流水线计划未持有有效执行租约");
  }
  return {
    planId: plan.id,
    attempt: plan.attempt,
    leaseOwner: plan.lease_owner,
    leaseExpiresAt: plan.lease_expires_at,
  };
}

async function markStageRunning(
  execution: PipelineExecution,
  stage: StageRunRow,
): Promise<PipelineExecution | null> {
  return getDb().transaction(async (database) => {
    const now = Date.now();
    const leaseExpiresAt = now + 60_000;
    const updated = await database.prepare(`
      WITH active_plan AS (
        SELECT id
        FROM pipeline_plans
        WHERE id = ?
          AND status = 'running'
          AND attempt = ?
          AND lease_owner = ?
          AND lease_expires_at = ?
          AND lease_expires_at > ?
        FOR UPDATE
      ),
      updated_stage AS (
        UPDATE pipeline_stage_runs
        SET status = 'running', started_at = COALESCE(started_at, ?), error = ''
        WHERE id = ?
          AND plan_id = ?
          AND status = ?
          AND EXISTS (SELECT 1 FROM active_plan)
        RETURNING id
      )
      UPDATE pipeline_plans AS plan
      SET lease_expires_at = ?, updated_at = ?
      FROM active_plan
      WHERE plan.id = active_plan.id
        AND EXISTS (SELECT 1 FROM updated_stage)
      RETURNING plan.lease_expires_at
    `).get<{ lease_expires_at: number }>(
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      now,
      now,
      stage.id,
      execution.planId,
      stage.status,
      leaseExpiresAt,
      now,
    );
    if (!updated) return null;
    await addPipelineEvent(database, execution.planId, 'stage.running', { stageKey: stage.stage_key, position: stage.position });
    return { ...execution, leaseExpiresAt: updated.lease_expires_at };
  })();
}

async function markStageSucceeded(
  execution: PipelineExecution,
  stage: StageRunRow,
  checkpoint: Record<string, unknown>,
  artifactHash: string,
): Promise<PipelineExecution | null> {
  return getDb().transaction(async (database) => {
    const now = Date.now();
    const leaseExpiresAt = now + 60_000;
    const output = { ...mockMarker(), stage: stage.stage_key, checkpoint, artifactHash, updatedAt: now };
    const updated = await database.prepare(`
      WITH active_plan AS (
        SELECT id
        FROM pipeline_plans
        WHERE id = ?
          AND status = 'running'
          AND attempt = ?
          AND lease_owner = ?
          AND lease_expires_at = ?
          AND lease_expires_at > ?
        FOR UPDATE
      ),
      updated_stage AS (
        UPDATE pipeline_stage_runs
        SET status = 'succeeded', checkpoint_json = ?, artifact_hash = ?, error = '', finished_at = ?
        WHERE id = ?
          AND plan_id = ?
          AND status = ?
          AND EXISTS (SELECT 1 FROM active_plan)
        RETURNING id
      )
      UPDATE pipeline_plans AS plan
      SET output_json = ?, error = '', lease_expires_at = ?, updated_at = ?
      FROM active_plan
      WHERE plan.id = active_plan.id
        AND EXISTS (SELECT 1 FROM updated_stage)
      RETURNING plan.lease_expires_at
    `).get<{ lease_expires_at: number }>(
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      now,
      JSON.stringify({ ...mockMarker(), ...checkpoint }),
      artifactHash,
      now,
      stage.id,
      execution.planId,
      stage.status,
      JSON.stringify(output),
      leaseExpiresAt,
      now,
    );
    if (!updated) return null;
    await addPipelineEvent(database, execution.planId, 'stage.succeeded', { stageKey: stage.stage_key, artifactHash });
    if (stage.stage_key === 'notify') {
      await addPipelineEvent(database, execution.planId, 'notification.mock_delivered', {
        sink: 'pipeline_events',
        delivered: true,
        stageKey: stage.stage_key,
      });
    }
    return { ...execution, leaseExpiresAt: updated.lease_expires_at };
  })();
}

async function awaitHumanReview(execution: PipelineExecution, stage: StageRunRow): Promise<boolean> {
  return getDb().transaction(async (database) => {
    const now = Date.now();
    const checkpoint = {
      ...mockMarker(),
      manualApprovalRequired: true,
      boundary: 'This action does not approve a master or publish content.',
      waitingSince: now,
    };
    const updated = await database.prepare(`
      WITH active_plan AS (
        SELECT id
        FROM pipeline_plans
        WHERE id = ?
          AND status = 'running'
          AND attempt = ?
          AND lease_owner = ?
          AND lease_expires_at = ?
          AND lease_expires_at > ?
        FOR UPDATE
      ),
      paused_stage AS (
        UPDATE pipeline_stage_runs
        SET status = 'paused', checkpoint_json = ?, error = '', started_at = COALESCE(started_at, ?)
        WHERE id = ?
          AND plan_id = ?
          AND status = ?
          AND EXISTS (SELECT 1 FROM active_plan)
        RETURNING id
      )
      UPDATE pipeline_plans AS plan
      SET status = 'awaiting_review', output_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      FROM active_plan
      WHERE plan.id = active_plan.id
        AND EXISTS (SELECT 1 FROM paused_stage)
      RETURNING plan.id
    `).get<{ id: string }>(
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      now,
      JSON.stringify(checkpoint),
      now,
      stage.id,
      execution.planId,
      stage.status,
      JSON.stringify({ ...mockMarker(), stage: stage.stage_key, awaitingReview: true, checkpoint }),
      now,
    );
    if (!updated) return false;
    await addPipelineEvent(database, execution.planId, 'plan.awaiting_review', { stageKey: stage.stage_key, manualApprovalRequired: true });
    return true;
  })();
}

async function markPlanRetryWait(
  execution: PipelineExecution,
  stage: StageRunRow,
  error: Error,
): Promise<boolean> {
  return getDb().transaction(async (database) => {
    const now = Date.now();
    const retryAt = now + 60_000;
    const message = error.message.slice(0, 500);
    const output = { ...mockMarker(), stage: stage.stage_key, retryAt, error: message };
    const updated = await database.prepare(`
      WITH active_plan AS (
        SELECT id
        FROM pipeline_plans
        WHERE id = ?
          AND status = 'running'
          AND attempt = ?
          AND lease_owner = ?
          AND lease_expires_at = ?
          AND lease_expires_at > ?
        FOR UPDATE
      ),
      updated_stage AS (
        UPDATE pipeline_stage_runs
        SET status = 'queued', error = ?, checkpoint_json = ?
        WHERE id = ?
          AND plan_id = ?
          AND status = ?
          AND EXISTS (SELECT 1 FROM active_plan)
        RETURNING id
      )
      UPDATE pipeline_plans AS plan
      SET status = 'retry_wait', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
        error = ?, output_json = ?, updated_at = ?
      FROM active_plan
      WHERE plan.id = active_plan.id
        AND EXISTS (SELECT 1 FROM updated_stage)
      RETURNING plan.id
    `).get<{ id: string }>(
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      now,
      message,
      JSON.stringify({ ...mockMarker(), retryAt, error: message }),
      stage.id,
      execution.planId,
      stage.status,
      retryAt,
      message,
      JSON.stringify(output),
      now,
    );
    if (!updated) return false;
    await addPipelineEvent(database, execution.planId, 'plan.retry_wait', { stageKey: stage.stage_key, retryAt, error: message });
    return true;
  })();
}

async function markPlanFailed(
  execution: PipelineExecution,
  stage: StageRunRow | null,
  error: Error,
): Promise<boolean> {
  return getDb().transaction(async (database) => {
    const now = Date.now();
    const message = error.message.slice(0, 500);
    let updated: { id: string } | undefined;
    if (stage) {
      updated = await database.prepare(`
        WITH active_plan AS (
          SELECT id
          FROM pipeline_plans
          WHERE id = ?
            AND status = 'running'
            AND attempt = ?
            AND lease_owner = ?
            AND lease_expires_at = ?
            AND lease_expires_at > ?
          FOR UPDATE
        ),
        failed_stage AS (
          UPDATE pipeline_stage_runs
          SET status = 'failed', error = ?, finished_at = ?
          WHERE id = ?
            AND plan_id = ?
            AND status = ?
            AND EXISTS (SELECT 1 FROM active_plan)
          RETURNING id
        )
        UPDATE pipeline_plans AS plan
        SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL,
          finished_at = ?, updated_at = ?
        FROM active_plan
        WHERE plan.id = active_plan.id
          AND EXISTS (SELECT 1 FROM failed_stage)
        RETURNING plan.id
      `).get<{ id: string }>(
        execution.planId,
        execution.attempt,
        execution.leaseOwner,
        execution.leaseExpiresAt,
        now,
        message,
        now,
        stage.id,
        execution.planId,
        stage.status,
        message,
        now,
        now,
      );
    } else {
      updated = await database.prepare(`
        WITH active_plan AS (
          SELECT id
          FROM pipeline_plans
          WHERE id = ?
            AND status = 'running'
            AND attempt = ?
            AND lease_owner = ?
            AND lease_expires_at = ?
            AND lease_expires_at > ?
          FOR UPDATE
        )
        UPDATE pipeline_plans AS plan
        SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL,
          finished_at = ?, updated_at = ?
        FROM active_plan
        WHERE plan.id = active_plan.id
        RETURNING plan.id
      `).get<{ id: string }>(
        execution.planId,
        execution.attempt,
        execution.leaseOwner,
        execution.leaseExpiresAt,
        now,
        message,
        now,
        now,
      );
    }
    if (!updated) return false;
    await addPipelineEvent(database, execution.planId, 'plan.failed', { stageKey: stage?.stage_key ?? 'human_review', error: message });
    return true;
  })();
}

async function completePipelinePlan(execution: PipelineExecution): Promise<boolean> {
  return getDb().transaction(async (database) => {
    const activePlan = await database.prepare(`
      SELECT id
      FROM pipeline_plans
      WHERE id = ?
        AND status = 'running'
        AND attempt = ?
        AND lease_owner = ?
        AND lease_expires_at = ?
        AND lease_expires_at > ?
      FOR UPDATE
    `).get<{ id: string }>(
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      Date.now(),
    );
    if (!activePlan) return false;
    const stages = await database.prepare(`
      SELECT id, plan_id, stage_key, position, status, checkpoint_json, artifact_hash, error, started_at, finished_at
      FROM pipeline_stage_runs
      WHERE plan_id = ?
      ORDER BY position
      FOR UPDATE
    `).all<StageRunRow>(execution.planId);
    if (!stages.length || stages.some((stage) => stage.status !== 'succeeded')) return false;
    const review = stages.find((stage) => stage.stage_key === 'human_review');
    if (!review) throw new ApiError(409, '计划缺少已完成的人工复审检查点，不能成功结束');
    const checkpoint = parseRecord(review.checkpoint_json);
    const approvedBy = checkpoint.approvedBy;
    const approvedAt = checkpoint.approvedAt;
    if (checkpoint.manualApproval !== true || typeof approvedBy !== 'string' || !approvedBy.trim() || typeof approvedAt !== 'number' || !Number.isFinite(approvedAt)) {
      throw new ApiError(409, '人工复审检查点不完整，不能成功结束');
    }
    const now = Date.now();
    const humanReview = { stageRunId: review.id, approvedBy, approvedAt };
    const updated = await database.prepare(`
      UPDATE pipeline_plans
      SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
        finished_at = ?, updated_at = ?, output_json = ?
      WHERE id = ?
        AND status = 'running'
        AND attempt = ?
        AND lease_owner = ?
        AND lease_expires_at = ?
        AND lease_expires_at > ?
      RETURNING id
    `).get<{ id: string }>(
      now,
      now,
      JSON.stringify({ ...mockMarker(), stage: 'complete', completedAt: now, humanReview, publish: false, masterApproved: false }),
      execution.planId,
      execution.attempt,
      execution.leaseOwner,
      execution.leaseExpiresAt,
      now,
    );
    if (!updated) return false;
    await addPipelineEvent(database, execution.planId, 'plan.succeeded', { humanReview, publish: false, masterApproved: false });
    return true;
  })();
}

async function runPipelineStage(plan: PlanRow, stage: StageRunRow, stages: StageRunRow[]) {
  const input = parseRecord(plan.input_json);
  if (stage.stage_key === "knowledge_expand") {
    const theme = typeof input.theme === "string" && input.theme.trim() ? input.theme : plan.name;
    const expansion = createMockKnowledgeExpansion({ theme, maxPoints: 5 });
    return {
      checkpoint: {
        ...mockMarker(),
        artifactKind: "knowledge-expansion",
        expansion,
        humanKnowledgeConfirmationRequired: true,
      },
      artifactHash: contentHash(expansion),
    };
  }
  if (stage.stage_key === "song_generate") {
    await reserveMiniMaxRateLimit("pipeline", [MOCK_MUSIC_MODEL]);
    const knowledge = stages.find((candidate) => candidate.stage_key === "knowledge_expand");
    const knowledgeHash = knowledge?.artifact_hash || contentHash(input);
    const run = await generateMiniMaxMusic({
      model: MOCK_MUSIC_MODEL,
      prompt: `Mock pipeline music for ${plan.name}`,
      lyrics: "Mock provider generates a deterministic WAV artifact for pipeline verification.",
      lyricsOptimizer: false,
      instrumental: false,
      audioSetting: { sampleRate: 44100, bitrate: 256000, format: "wav" },
      outputFormat: "hex",
      signal: new AbortController().signal,
    });
    if (!run.ok || !run.audioBytes) throw new Error(run.error || "Mock music provider did not return WAV bytes");
    const audioHash = createHash("sha256").update(run.audioBytes).digest("hex");
    return {
      checkpoint: {
        ...mockMarker(),
        artifactKind: "audio/wav",
        audioHash,
        bytes: run.audioBytes.byteLength,
        durationMs: run.durationMs,
        sampleRate: run.sampleRate,
        channels: run.channels,
        model: run.model,
        knowledgeHash,
      },
      artifactHash: audioHash,
    };
  }
  if (stage.stage_key === "media_analyze") {
    const song = stages.find((candidate) => candidate.stage_key === "song_generate");
    const songCheckpoint = song ? parseRecord(song.checkpoint_json) : {};
    const audioHash = typeof songCheckpoint.audioHash === "string" ? songCheckpoint.audioHash : "";
    if (!audioHash) throw new Error("媒体阶段缺少 Mock WAV 产物");
    const dimensionNames = ["响度与安全", "动态起伏", "节奏适配", "适唱音域", "人声清晰度", "重复与结构", "留白接唱", "频谱舒适度", "时长适配"];
    const dimensions = dimensionNames.map((label, index) => ({
      label,
      score: 72 + (Number.parseInt(audioHash.slice(index * 2, index * 2 + 2), 16) % 18),
      source: "mock-checkpoint",
    }));
    const report = {
      ...mockMarker(),
      reportKind: "mock-media-report-v1",
      artifactHash: audioHash,
      dimensions,
      automaticPreScreenOnly: true,
      requiresHumanReview: true,
    };
    return { checkpoint: report, artifactHash: contentHash(report) };
  }
  if (stage.stage_key === "notify") {
    const report = stages.find((candidate) => candidate.stage_key === "media_analyze");
    return {
      checkpoint: {
        ...mockMarker(),
        sink: "pipeline_events",
        delivered: true,
        reportArtifactHash: report?.artifact_hash ?? "",
      },
      artifactHash: contentHash({ planId: plan.id, stage: stage.stage_key, reportHash: report?.artifact_hash ?? "" }),
    };
  }
  throw new Error(`不支持的流水线阶段：${stage.stage_key}`);
}

export async function executePipelinePlan(planId: string, workerId = `after:${randomUUID()}`): Promise<void> {
  const current = await readPlan(getDb(), planId);
  if (current.status === 'cancelling') {
    await finaliseCancellation(planId);
    return;
  }
  const claimed = await claimPipelinePlan(planId, workerId);
  if (!claimed) return;
  let execution = pipelineExecutionFromClaim(claimed);
  const stages = await getDb().prepare(`
    SELECT id, plan_id, stage_key, position, status, checkpoint_json, artifact_hash, error, started_at, finished_at
    FROM pipeline_stage_runs WHERE plan_id = ? ORDER BY position
  `).all<StageRunRow>(planId);
  const humanReview = stages.find((stage) => stage.stage_key === 'human_review');
  if (!humanReview) {
    const failed = await markPlanFailed(execution, null, new ApiError(409, '计划缺少人工复审阶段，不能继续执行'));
    if (!failed) await finaliseCancellation(planId);
    return;
  }
  for (const stage of stages) {
    if (['succeeded', 'skipped', 'cancelled'].includes(stage.status)) continue;
    if (stage.stage_key === 'human_review') {
      if (stage.status !== 'queued') {
        const failed = await markPlanFailed(execution, null, new ApiError(409, '人工复审阶段状态不允许执行'));
        if (!failed) await finaliseCancellation(planId);
        return;
      }
      const paused = await awaitHumanReview(execution, stage);
      if (!paused) await finaliseCancellation(planId);
      return;
    }
    if (!['queued', 'running'].includes(stage.status)) {
      const failed = await markPlanFailed(execution, null, new ApiError(409, `流水线阶段状态不允许执行：${stage.stage_key}`));
      if (!failed) await finaliseCancellation(planId);
      return;
    }
    const activeExecution = await markStageRunning(execution, stage);
    if (!activeExecution) {
      await finaliseCancellation(planId);
      return;
    }
    execution = activeExecution;
    stage.status = 'running';
    try {
      const result = await runPipelineStage(claimed, stage, stages);
      const completedExecution = await markStageSucceeded(execution, stage, result.checkpoint, result.artifactHash);
      if (!completedExecution) {
        await finaliseCancellation(planId);
        return;
      }
      execution = completedExecution;
      stage.status = 'succeeded';
      stage.checkpoint_json = JSON.stringify(result.checkpoint);
      stage.artifact_hash = result.artifactHash;
    } catch (error) {
      const typed = error instanceof Error ? error : new Error(String(error));
      const transitioned = error instanceof ApiError && error.status === 429
        ? await markPlanRetryWait(execution, stage, typed)
        : await markPlanFailed(execution, stage, typed);
      if (!transitioned) await finaliseCancellation(planId);
      return;
    }
  }
  if (humanReview.status !== 'succeeded') {
    const failed = await markPlanFailed(execution, null, new ApiError(409, '人工复审阶段未完成，不能成功结束'));
    if (!failed) await finaliseCancellation(planId);
    return;
  }
  const completed = await completePipelinePlan(execution);
  if (!completed) await finaliseCancellation(planId);
}
