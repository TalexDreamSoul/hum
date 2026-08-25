import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { recordAudit, type SessionUser } from "./auth";
import { getDb, type HumDatabase } from "./database";

const RESOURCE_VALUES = ["dashboard", "roles", "rubrics", "rounds", "benchmarks", "gates", "audit"] as const;
const ROLE_VALUES = ["admin", "approver", "uploader"] as const;
const opaqueIdSchema = z.string().trim().min(1).max(160);
const REVIEW_KIND_VALUES = ["content", "music"] as const;

const paginationSchema = z.object({
  resource: z.enum(RESOURCE_VALUES),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  status: z.string().trim().max(80).optional(),
  reviewer: opaqueIdSchema.optional(),
  action: z.string().trim().max(120).optional(),
  target: z.string().trim().max(160).optional(),
  date: z.coerce.number().int().nonnegative().optional(),
  dateFrom: z.coerce.number().int().nonnegative().optional(),
  dateTo: z.coerce.number().int().nonnegative().optional(),
});

export const governanceQuerySchema = paginationSchema.superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "dateFrom 不能晚于 dateTo", path: ["dateFrom"] });
  }
});

const dimensionsSchema = z.array(z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1).max(120),
  weight: z.number().int().min(1).max(100),
})).min(1).max(20).superRefine((dimensions, context) => {
  const keys = new Set<string>();
  for (const [index, dimension] of dimensions.entries()) {
    if (keys.has(dimension.key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "量表维度 key 必须唯一", path: [index, "key"] });
    keys.add(dimension.key);
  }
  if (dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) !== 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "量表维度权重之和必须为 100" });
  }
});

const payloadSchemas = {
  roleUpdate: z.object({ role: z.enum(ROLE_VALUES), permissions: z.array(z.string().trim().min(1).max(80)).min(1).max(32) }),
  rubricCreate: z.object({
    rubricKey: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string().trim().min(1).max(120),
    subjectType: z.enum(["audio", "video", "knowledge", "publication"]),
    dimensions: dimensionsSchema,
    threshold: z.number().int().min(0).max(100),
  }),
  rubricRevise: z.object({ rubricId: opaqueIdSchema, dimensions: dimensionsSchema, threshold: z.number().int().min(0).max(100) }),
  rubricRetire: z.object({ rubricId: opaqueIdSchema }),
  roundOpen: z.object({ candidateId: opaqueIdSchema }),
  roundAssign: z.object({ roundId: opaqueIdSchema, contentReviewerId: opaqueIdSchema, musicReviewerId: opaqueIdSchema }),
  roundSubmit: z.object({
    roundId: opaqueIdSchema,
    reviewKind: z.enum(REVIEW_KIND_VALUES),
    verdict: z.enum(["pass", "fail", "needs_inpaint"]),
    scores: z.record(z.string(), z.unknown()).optional(),
    score: z.number().min(0).max(100).optional(),
    notes: z.string().trim().max(4_000).default(""),
  }).refine((value) => value.scores !== undefined || value.score !== undefined, { message: "必须提交 scores 或 score" }),
  roundRequestChanges: z.object({ roundId: opaqueIdSchema, notes: z.string().trim().min(1).max(4_000) }),
  roundClose: z.object({ roundId: opaqueIdSchema }),
  benchmarkCreate: z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(2_000).default(""), rubricRevisionId: opaqueIdSchema.nullable().optional() }),
  benchmarkRevise: z.object({ benchmarkId: opaqueIdSchema, rubricRevisionId: opaqueIdSchema.nullable().optional() }),
  benchmarkAddItem: z.object({ benchmarkRevisionId: opaqueIdSchema, reportId: opaqueIdSchema }),
  benchmarkRun: z.object({ benchmarkRevisionId: opaqueIdSchema, model: z.string().trim().min(1).max(120).default("music-3.0-free") }),
  gateEvaluate: z.object({ candidateId: opaqueIdSchema.optional(), publicationRevisionId: opaqueIdSchema.optional() }).refine((value) => Boolean(value.candidateId || value.publicationRevisionId), { message: "必须指定 candidateId 或 publicationRevisionId" }),
  gateFinalPass: z.object({ candidateId: opaqueIdSchema.optional(), publicationRevisionId: opaqueIdSchema.optional() }).refine((value) => Boolean(value.candidateId || value.publicationRevisionId), { message: "必须指定 candidateId 或 publicationRevisionId" }),
  auditExport: z.object({ format: z.enum(["json", "csv"]).default("json"), search: z.string().trim().max(160).optional(), action: z.string().trim().max(120).optional(), target: z.string().trim().max(160).optional(), dateFrom: z.coerce.number().int().nonnegative().optional(), dateTo: z.coerce.number().int().nonnegative().optional() }),
};

export const governancePostSchema = z.object({
  resource: z.enum(["roles", "rubrics", "rounds", "benchmarks", "gates", "audit"]),
  action: z.string().trim().min(1).max(80),
  payload: z.unknown(),
});

type GovernanceQuery = z.infer<typeof governanceQuerySchema>;
type GovernanceRequest = z.infer<typeof governancePostSchema>;
type Role = z.infer<typeof payloadSchemas.roleUpdate>["role"];

const CORE_PERMISSIONS: Record<Role, readonly string[]> = {
  admin: ["configure", "publish", "final_review", "manage"],
  approver: ["content_review", "music_review", "compare", "read"],
  uploader: ["draft", "upload", "submit", "read_own"],
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function pageOffset(page: number, pageSize: number) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

function scopeDates(query: GovernanceQuery, column: string, where: string[], values: unknown[]) {
  const start = query.dateFrom ?? query.date;
  const end = query.dateTo ?? (query.date ? query.date + 86_400_000 : undefined);
  if (start !== undefined) { where.push(`${column} >= ?`); values.push(start); }
  if (end !== undefined) { where.push(`${column} <= ?`); values.push(end); }
}

async function listDashboard() {
  const db = getDb();
  const [pending, reviewTotals, blocked, reports, queue, coverage] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS count FROM review_assignments WHERE status = 'assigned'").get<{ count: number }>(),
    db.prepare("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE verdict = 'pass')::int AS passed FROM candidate_reviews WHERE review_kind IN ('content','music')").get<{ total: number; passed: number }>(),
    db.prepare("SELECT COUNT(*)::int AS count FROM release_gate_checks WHERE verdict = 'block'").get<{ count: number }>(),
    db.prepare("SELECT COUNT(*)::int AS count FROM evaluation_reports").get<{ count: number }>(),
    db.prepare("SELECT COUNT(*)::int AS count FROM pipeline_plans WHERE status IN ('queued','running','paused')").get<{ count: number }>(),
    db.prepare("SELECT COUNT(DISTINCT seed)::int AS seeded, COUNT(*)::int AS total FROM candidates").get<{ seeded: number; total: number }>(),
  ]);
  return {
    pendingReviews: pending?.count ?? 0,
    reviewPassRate: reviewTotals?.total ? (reviewTotals.passed / reviewTotals.total) : 0,
    blockedGates: blocked?.count ?? 0,
    evaluationReports: reports?.count ?? 0,
    queueDepth: queue?.count ?? 0,
    seedCoverage: { seeded: coverage?.seeded ?? 0, total: coverage?.total ?? 0, rate: coverage?.total ? coverage.seeded / coverage.total : 0 },
  };
}

async function listRoles(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("(role ILIKE ? OR label ILIKE ?)"); values.push(`%${query.search}%`, `%${query.search}%`); }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getDb().prepare(`SELECT COUNT(*)::int AS count FROM role_policies ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await getDb().prepare(`SELECT role, tier, label, permissions_json, updated_by, updated_at FROM role_policies ${filter} ORDER BY tier LIMIT ? OFFSET ?`).all<{ role: Role; tier: string; label: string; permissions_json: string; updated_by: string | null; updated_at: number }>(...values, limit, offset);
  return { items: rows.map((row) => ({ role: row.role, tier: row.tier, label: row.label, permissions: json(row.permissions_json), updatedBy: row.updated_by, updatedAt: row.updated_at })), total: total?.count ?? 0 };
}

async function listRubrics(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("(r.rubric_key ILIKE ? OR r.name ILIKE ?)"); values.push(`%${query.search}%`, `%${query.search}%`); }
  if (query.status) { where.push("r.status = ?"); values.push(query.status); }
  scopeDates(query, "r.updated_at", where, values);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getDb().prepare(`SELECT COUNT(*)::int AS count FROM review_rubrics r ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await getDb().prepare(`
    SELECT r.id, r.rubric_key, r.name, r.subject_type, r.status, r.current_revision, r.created_by, r.created_at, r.updated_at,
           v.id AS revision_id, v.dimensions_json, v.threshold, v.content_hash, v.created_at AS revision_created_at
    FROM review_rubrics r
    LEFT JOIN rubric_revisions v ON v.rubric_id = r.id AND v.revision = r.current_revision
    ${filter} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?
  `).all<Record<string, unknown>>(...values, limit, offset);
  return { items: rows.map((row) => ({ id: row.id, rubricKey: row.rubric_key, name: row.name, subjectType: row.subject_type, status: row.status, currentRevision: row.current_revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision_id ? { id: row.revision_id, dimensions: json(String(row.dimensions_json)), threshold: row.threshold, contentHash: row.content_hash, createdAt: row.revision_created_at } : null })), total: total?.count ?? 0 };
}

async function listRounds(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("r.candidate_id::text ILIKE ?"); values.push(`%${query.search}%`); }
  if (query.status) { where.push("r.status = ?"); values.push(query.status); }
  if (query.reviewer) { where.push("EXISTS (SELECT 1 FROM review_assignments ra WHERE ra.review_round_id = r.id AND ra.reviewer_id = ?)"); values.push(query.reviewer); }
  scopeDates(query, "r.created_at", where, values);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = await db.prepare(`SELECT COUNT(*)::int AS count FROM review_rounds r ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await db.prepare(`SELECT r.* FROM review_rounds r ${filter} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all<Record<string, unknown>>(...values, limit, offset);
  const ids = rows.map((row) => String(row.id));
  const assignments = ids.length ? await db.prepare(`
    SELECT a.id, a.review_round_id, a.review_kind, a.reviewer_id, u.display_name AS reviewer_name, a.status, a.assigned_by, a.created_at, a.submitted_at
    FROM review_assignments a JOIN users u ON u.id = a.reviewer_id WHERE a.review_round_id IN (${ids.map(() => "?").join(",")}) ORDER BY a.review_kind
  `).all<Record<string, unknown>>(...ids) : [];
  const byRound = new Map<string, Record<string, unknown>[]>();
  for (const assignment of assignments) {
    const key = String(assignment.review_round_id);
    byRound.set(key, [...(byRound.get(key) ?? []), { id: assignment.id, reviewKind: assignment.review_kind, reviewerId: assignment.reviewer_id, reviewerName: assignment.reviewer_name, status: assignment.status, assignedBy: assignment.assigned_by, createdAt: assignment.created_at, submittedAt: assignment.submitted_at }]);
  }
  return { items: rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, roundNo: row.round_no, status: row.status, openedBy: row.opened_by, closedBy: row.closed_by, createdAt: row.created_at, closedAt: row.closed_at, assignments: byRound.get(String(row.id)) ?? [] })), total: total?.count ?? 0 };
}

async function listBenchmarks(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("(b.name ILIKE ? OR b.description ILIKE ?)"); values.push(`%${query.search}%`, `%${query.search}%`); }
  if (query.status) { where.push("b.status = ?"); values.push(query.status); }
  scopeDates(query, "b.updated_at", where, values);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = await db.prepare(`SELECT COUNT(*)::int AS count FROM benchmark_sets b ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await db.prepare(`
    SELECT b.*, v.id AS revision_id, v.rubric_revision_id, v.content_hash,
      (SELECT COUNT(*)::int FROM benchmark_items bi WHERE bi.benchmark_revision_id = v.id) AS item_count,
      (SELECT COUNT(*)::int FROM benchmark_runs br WHERE br.benchmark_revision_id = v.id) AS run_count
    FROM benchmark_sets b LEFT JOIN benchmark_set_revisions v ON v.benchmark_set_id = b.id AND v.revision = b.current_revision
    ${filter} ORDER BY b.updated_at DESC LIMIT ? OFFSET ?
  `).all<Record<string, unknown>>(...values, limit, offset);
  return { items: rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status, currentRevision: row.current_revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision_id ? { id: row.revision_id, rubricRevisionId: row.rubric_revision_id, contentHash: row.content_hash, itemCount: row.item_count, runCount: row.run_count } : null })), total: total?.count ?? 0 };
}

async function listGates(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("(g.candidate_id::text ILIKE ? OR g.publication_revision_id::text ILIKE ? OR g.gate_key ILIKE ?)"); values.push(`%${query.search}%`, `%${query.search}%`, `%${query.search}%`); }
  if (query.status) { where.push("g.verdict = ?"); values.push(query.status); }
  if (query.reviewer) { where.push("g.checked_by = ?"); values.push(query.reviewer); }
  scopeDates(query, "g.created_at", where, values);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getDb().prepare(`SELECT COUNT(*)::int AS count FROM release_gate_checks g ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await getDb().prepare(`
    SELECT g.*, u.display_name AS checked_by_name FROM release_gate_checks g LEFT JOIN users u ON u.id = g.checked_by
    ${filter} ORDER BY g.created_at DESC LIMIT ? OFFSET ?
  `).all<Record<string, unknown>>(...values, limit, offset);
  return { items: rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, publicationRevisionId: row.publication_revision_id, gateKey: row.gate_key, verdict: row.verdict, evidence: json(String(row.evidence_json)), checkedBy: row.checked_by, checkedByName: row.checked_by_name, createdAt: row.created_at })), total: total?.count ?? 0 };
}

async function listAudit(query: GovernanceQuery) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.search) { where.push("(a.action ILIKE ? OR a.target_type ILIKE ? OR a.target_id ILIKE ?)"); values.push(`%${query.search}%`, `%${query.search}%`, `%${query.search}%`); }
  if (query.action) { where.push("a.action = ?"); values.push(query.action); }
  if (query.target) { where.push("(a.target_type = ? OR a.target_id = ?)"); values.push(query.target, query.target); }
  if (query.reviewer) { where.push("a.actor_user_id = ?"); values.push(query.reviewer); }
  scopeDates(query, "a.created_at", where, values);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = await db.prepare(`SELECT COUNT(*)::int AS count FROM audit_log a ${filter}`).get<{ count: number }>(...values);
  const { limit, offset } = pageOffset(query.page, query.pageSize);
  const rows = await db.prepare(`
    SELECT a.*, u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
    ${filter} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all<Record<string, unknown>>(...values, limit, offset);
  return { items: rows.map((row) => ({ id: row.id, actorUserId: row.actor_user_id, actorName: row.actor_name, action: row.action, targetType: row.target_type, targetId: row.target_id, detail: json(String(row.detail_json)), createdAt: row.created_at })), total: total?.count ?? 0 };
}

export async function listGovernance(input: unknown) {
  const query = governanceQuerySchema.parse(input);
  if (query.resource === "dashboard") return { items: [await listDashboard()], page: 1, pageSize: 1, total: 1 };
  const result = query.resource === "roles" ? await listRoles(query)
    : query.resource === "rubrics" ? await listRubrics(query)
      : query.resource === "rounds" ? await listRounds(query)
        : query.resource === "benchmarks" ? await listBenchmarks(query)
          : query.resource === "gates" ? await listGates(query)
            : await listAudit(query);
  return { ...result, page: query.page, pageSize: query.pageSize };
}

function assertAdmin(user: SessionUser) {
  if (user.role !== "admin") throw new ApiError(403, "此操作仅 A 级管理员可执行");
}

function assertApproverOrAdmin(user: SessionUser) {
  if (user.role !== "admin" && user.role !== "approver") throw new ApiError(403, "此操作需要 A 或 B 级权限");
}

async function requireActiveUser(database: HumDatabase, id: string, label: string) {
  const reviewer = await database.prepare(`
    SELECT id, role
    FROM users
    WHERE id = ? AND status = 'active'
    FOR UPDATE
  `).get<{ id: string; role: Role }>(id);
  if (!reviewer) throw new ApiError(404, `${label}不存在或已停用`);
  if (reviewer.role !== "admin" && reviewer.role !== "approver") {
    throw new ApiError(403, `${label}必须是有效的 A 或 B 级用户`);
  }
}

type HumanReviewKind = (typeof REVIEW_KIND_VALUES)[number];

interface SubmittedHumanReview {
  id: string;
  verdict: string;
  reviewerId: string;
}

interface CurrentCandidateReviewRound {
  id: string;
  candidateId: string;
  roundNo: number;
  status: string;
  reviews: Map<HumanReviewKind, SubmittedHumanReview>;
}

async function submittedHumanReviewsForRound(
  database: HumDatabase,
  roundId: string,
  candidateId: string,
  roundNo: number,
): Promise<Map<HumanReviewKind, SubmittedHumanReview>> {
  const rows = await database.prepare(`
    SELECT r.id, r.review_kind, r.verdict, r.reviewer_id
    FROM review_assignments a
    JOIN candidate_reviews r
      ON r.assignment_id = a.id
      AND r.candidate_id = ?
      AND r.round_no = ?
      AND r.review_kind = a.review_kind
      AND r.reviewer_id = a.reviewer_id
      AND r.created_at >= a.created_at
    WHERE a.review_round_id = ? AND a.status = 'submitted'
    ORDER BY r.review_kind, r.created_at DESC
  `).all<{ id: string; review_kind: HumanReviewKind; verdict: string; reviewer_id: string }>(candidateId, roundNo, roundId);
  const reviews = new Map<HumanReviewKind, SubmittedHumanReview>();
  for (const row of rows) {
    if (!reviews.has(row.review_kind)) {
      reviews.set(row.review_kind, { id: row.id, verdict: row.verdict, reviewerId: row.reviewer_id });
    }
  }
  return reviews;
}

async function currentCandidateReviewRound(
  database: HumDatabase,
  candidateId: string,
): Promise<CurrentCandidateReviewRound | null> {
  const round = await database.prepare(`
    SELECT id, candidate_id, round_no, status
    FROM review_rounds
    WHERE candidate_id = ?
    ORDER BY round_no DESC
    LIMIT 1
    FOR UPDATE
  `).get<{ id: string; candidate_id: string; round_no: number; status: string }>(candidateId);
  if (!round) return null;
  return {
    id: round.id,
    candidateId: round.candidate_id,
    roundNo: round.round_no,
    status: round.status,
    reviews: await submittedHumanReviewsForRound(database, round.id, round.candidate_id, round.round_no),
  };
}

export async function requireCurrentCandidateHumanReviewRound(
  database: HumDatabase,
  candidateId: string,
): Promise<{ roundId: string; roundNo: number; contentReviewerId: string; musicReviewerId: string }> {
  const round = await currentCandidateReviewRound(database, candidateId);
  if (!round) throw new ApiError(409, "候选尚未开始当前人工评审轮次");
  if (round.status !== "passed") throw new ApiError(409, "当前人工评审轮次尚未通过");
  const content = round.reviews.get("content");
  const music = round.reviews.get("music");
  if (content?.verdict !== "pass" || music?.verdict !== "pass") {
    throw new ApiError(409, "当前评审轮次的内容与音乐评审必须均通过");
  }
  if (content.reviewerId === music.reviewerId) {
    throw new ApiError(409, "当前评审轮次的内容与音乐评审必须由不同人员完成");
  }
  return {
    roundId: round.id,
    roundNo: round.roundNo,
    contentReviewerId: content.reviewerId,
    musicReviewerId: music.reviewerId,
  };
}

async function ensureLegacyRound(database: HumDatabase, candidateId: string) {
  const existing = await database.prepare("SELECT id FROM review_rounds WHERE candidate_id = ? AND round_no = 1").get<{ id: string }>(candidateId);
  if (existing) return existing.id;
  const legacy = await database.prepare("SELECT id, review_kind, reviewer_id, created_at FROM candidate_reviews WHERE candidate_id = ? AND round_no = 1 AND reviewer_id IS NOT NULL ORDER BY created_at ASC").all<{ id: string; review_kind: "content" | "music"; reviewer_id: string; created_at: number }>(candidateId);
  if (!legacy.length) return null;
  const roundId = randomUUID();
  const now = Date.now();
  await database.prepare("INSERT INTO review_rounds (id, candidate_id, round_no, status, created_at) VALUES (?, ?, 1, 'closed', ?)").run(roundId, candidateId, now);
  const seen = new Set<string>();
  for (const review of legacy) {
    if (seen.has(review.review_kind)) continue;
    seen.add(review.review_kind);
    const assignmentId = randomUUID();
    await database.prepare(`INSERT INTO review_assignments (id, review_round_id, review_kind, reviewer_id, status, created_at, submitted_at) VALUES (?, ?, ?, ?, 'submitted', ?, ?)`)
      .run(assignmentId, roundId, review.review_kind, review.reviewer_id, review.created_at, review.created_at);
    await database.prepare("UPDATE candidate_reviews SET assignment_id = ? WHERE id = ?").run(assignmentId, review.id);
  }
  return roundId;
}

async function openRound(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.roundOpen.parse(payload);
  const roundId = randomUUID();
  const now = Date.now();
  await database.transaction(async (database) => {
    const candidate = await database.prepare("SELECT id FROM candidates WHERE id = ? FOR UPDATE").get<{ id: string }>(input.candidateId);
    if (!candidate) throw new ApiError(404, "候选不存在");
    await ensureLegacyRound(database, input.candidateId);
    const latest = await database.prepare("SELECT COALESCE(MAX(round_no), 0)::int AS round_no FROM review_rounds WHERE candidate_id = ?").get<{ round_no: number }>(input.candidateId);
    await database.prepare("INSERT INTO review_rounds (id, candidate_id, round_no, status, opened_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)")
      .run(roundId, input.candidateId, (latest?.round_no ?? 0) + 1, user.id, now);
  })();
  return { id: roundId };
}

async function assignRound(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertApproverOrAdmin(user);
  const input = payloadSchemas.roundAssign.parse(payload);
  if (input.contentReviewerId === input.musicReviewerId) throw new ApiError(409, "内容与音乐评审必须由不同人员完成");
  const now = Date.now();
  await database.transaction(async (database) => {
    const round = await database.prepare("SELECT status FROM review_rounds WHERE id = ? FOR UPDATE").get<{ status: string }>(input.roundId);
    if (!round) throw new ApiError(404, "评审轮次不存在");
    if (!['open', 'changes_requested'].includes(round.status)) throw new ApiError(409, "当前轮次不能分配评审");
    await requireActiveUser(database, input.contentReviewerId, "内容评审员");
    await requireActiveUser(database, input.musicReviewerId, "音乐评审员");
    for (const [reviewKind, reviewerId] of [["content", input.contentReviewerId], ["music", input.musicReviewerId]] as const) {
      await database.prepare(`
        INSERT INTO review_assignments (id, review_round_id, review_kind, reviewer_id, status, assigned_by, created_at)
        VALUES (?, ?, ?, ?, 'assigned', ?, ?)
        ON CONFLICT (review_round_id, review_kind) DO UPDATE SET reviewer_id = EXCLUDED.reviewer_id, status = 'assigned', assigned_by = EXCLUDED.assigned_by, created_at = EXCLUDED.created_at, submitted_at = NULL
      `).run(randomUUID(), input.roundId, reviewKind, reviewerId, user.id, now);
    }
    await database.prepare("UPDATE review_rounds SET status = 'open' WHERE id = ?").run(input.roundId);
  })();
  return { id: input.roundId };
}

async function submitRound(database: HumDatabase, payload: unknown, user: SessionUser) {
  const input = payloadSchemas.roundSubmit.parse(payload);
  const now = Date.now();
  await database.transaction(async (database) => {
    const assignment = await database.prepare(`
      SELECT a.id, a.review_round_id, a.status, r.candidate_id, r.round_no, r.status AS round_status
      FROM review_assignments a JOIN review_rounds r ON r.id = a.review_round_id
      WHERE a.review_round_id = ? AND a.review_kind = ? AND a.reviewer_id = ? FOR UPDATE
    `).get<{ id: string; review_round_id: string; status: string; candidate_id: string; round_no: number; round_status: string }>(input.roundId, input.reviewKind, user.id);
    if (!assignment) throw new ApiError(403, "只能提交分配给自己的评审");
    if (assignment.status !== "assigned" || !['open', 'changes_requested'].includes(assignment.round_status)) throw new ApiError(409, "当前评审任务不能提交");
    await requireActiveUser(database, user.id, "评审员");
    const scores = input.scores ?? { total: input.score };
    const rubric = await database.prepare(`
      SELECT rr.id FROM review_rubrics r JOIN rubric_revisions rr ON rr.rubric_id = r.id AND rr.revision = r.current_revision
      WHERE r.status = 'active' AND r.subject_type = 'audio' ORDER BY r.updated_at DESC LIMIT 1
    `).get<{ id: string }>();
    await database.prepare(`
      INSERT INTO candidate_reviews (id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at, round_no, rubric_revision_id, assignment_id, decision_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), assignment.candidate_id, input.reviewKind, input.verdict, JSON.stringify(scores), input.notes, user.id, now, assignment.round_no, rubric?.id ?? null, assignment.id, input.notes);
    await database.prepare("UPDATE review_assignments SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now, assignment.id);
  })();
  return { id: input.roundId };
}

async function requestRoundChanges(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertApproverOrAdmin(user);
  const input = payloadSchemas.roundRequestChanges.parse(payload);
  await database.transaction(async (database) => {
    const round = await database.prepare("SELECT id, candidate_id, status FROM review_rounds WHERE id = ? FOR UPDATE").get<{ id: string; candidate_id: string; status: string }>(input.roundId);
    if (!round) throw new ApiError(404, "评审轮次不存在");
    if (round.status === "closed") throw new ApiError(409, "已关闭轮次不能请求修改");
    const candidate = await database.prepare("SELECT id, status FROM candidates WHERE id = ? FOR UPDATE").get<{ id: string; status: string }>(round.candidate_id);
    if (!candidate) throw new ApiError(404, "候选不存在");
    const master = await database.prepare("SELECT id FROM approved_masters WHERE candidate_id = ? AND status = 'approved' FOR UPDATE").get<{ id: string }>(candidate.id);
    if (candidate.status === "approved" || master) {
      throw new ApiError(409, "已批准母带的候选不能请求修改；请先显式退役母带");
    }
    await database.prepare("UPDATE review_rounds SET status = 'changes_requested' WHERE id = ?").run(round.id);
    await database.prepare("UPDATE candidates SET status = 'needs_inpaint', error = ?, updated_at = ? WHERE id = ?").run(input.notes, Date.now(), candidate.id);
  })();
  return { id: input.roundId };
}

async function closeRound(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertApproverOrAdmin(user);
  const input = payloadSchemas.roundClose.parse(payload);
  await database.transaction(async (database) => {
    const round = await database.prepare("SELECT id, candidate_id, round_no, status FROM review_rounds WHERE id = ? FOR UPDATE").get<{ id: string; candidate_id: string; round_no: number; status: string }>(input.roundId);
    if (!round) throw new ApiError(404, "评审轮次不存在");
    if (["closed", "passed"].includes(round.status)) throw new ApiError(409, "评审轮次已经结束");
    const assignments = await database.prepare("SELECT review_kind, reviewer_id, status FROM review_assignments WHERE review_round_id = ?").all<{ review_kind: HumanReviewKind; reviewer_id: string; status: string }>(round.id);
    const contentAssignment = assignments.find((assignment) => assignment.review_kind === "content");
    const musicAssignment = assignments.find((assignment) => assignment.review_kind === "music");
    if (assignments.length !== 2 || !contentAssignment || !musicAssignment || assignments.some((assignment) => assignment.status !== "submitted")) {
      throw new ApiError(409, "内容与音乐评审均提交后才能关闭");
    }
    if (contentAssignment.reviewer_id === musicAssignment.reviewer_id) {
      throw new ApiError(409, "内容与音乐评审必须由不同人员完成");
    }
    const reviews = await submittedHumanReviewsForRound(database, round.id, round.candidate_id, round.round_no);
    const content = reviews.get("content");
    const music = reviews.get("music");
    const passed = content?.verdict === "pass"
      && music?.verdict === "pass"
      && content.reviewerId !== music.reviewerId;
    await database.prepare("UPDATE review_rounds SET status = ?, closed_by = ?, closed_at = ? WHERE id = ?").run(passed ? "passed" : "closed", user.id, Date.now(), round.id);
  })();
  return { id: input.roundId };
}

async function createRubric(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.rubricCreate.parse(payload);
  const rubricId = randomUUID();
  const revisionId = randomUUID();
  const now = Date.now();
  await database.transaction(async (database) => {
    await database.prepare("INSERT INTO review_rubrics (id, rubric_key, name, subject_type, status, current_revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)")
      .run(rubricId, input.rubricKey, input.name, input.subjectType, user.id, now, now);
    await database.prepare("INSERT INTO rubric_revisions (id, rubric_id, revision, dimensions_json, threshold, content_hash, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
      .run(revisionId, rubricId, JSON.stringify(input.dimensions), input.threshold, hash({ rubricId, revision: 1, dimensions: input.dimensions, threshold: input.threshold }), user.id, now);
  })();
  return { id: rubricId, revisionId };
}

async function reviseRubric(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.rubricRevise.parse(payload);
  const revisionId = randomUUID();
  await database.transaction(async (database) => {
    const rubric = await database.prepare("SELECT id, current_revision, status FROM review_rubrics WHERE id = ? FOR UPDATE").get<{ id: string; current_revision: number; status: string }>(input.rubricId);
    if (!rubric) throw new ApiError(404, "量表不存在");
    if (rubric.status === "retired") throw new ApiError(409, "已退役量表不能修订");
    const revision = rubric.current_revision + 1;
    const now = Date.now();
    await database.prepare("INSERT INTO rubric_revisions (id, rubric_id, revision, dimensions_json, threshold, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(revisionId, rubric.id, revision, JSON.stringify(input.dimensions), input.threshold, hash({ rubricId: rubric.id, revision, dimensions: input.dimensions, threshold: input.threshold }), user.id, now);
    await database.prepare("UPDATE review_rubrics SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now, rubric.id);
  })();
  return { id: input.rubricId, revisionId };
}

async function retireRubric(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.rubricRetire.parse(payload);
  const result = await database.prepare("UPDATE review_rubrics SET status = 'retired', updated_at = ? WHERE id = ? AND status <> 'retired'").run(Date.now(), input.rubricId);
  if (!result.changes) throw new ApiError(404, "活动量表不存在");
  return { id: input.rubricId };
}

async function updateRole(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.roleUpdate.parse(payload);
  const permissions = [...new Set(input.permissions)];
  const missing = CORE_PERMISSIONS[input.role].filter((permission) => !permissions.includes(permission));
  if (missing.length) throw new ApiError(409, `核心权限不可删除：${missing.join(", ")}`);
  const result = await database.prepare("UPDATE role_policies SET permissions_json = ?, updated_by = ?, updated_at = ? WHERE role = ?").run(JSON.stringify(permissions), user.id, Date.now(), input.role);
  if (!result.changes) throw new ApiError(404, "角色策略不存在");
  return { id: input.role };
}

async function createBenchmark(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.benchmarkCreate.parse(payload);
  const benchmarkId = randomUUID();
  const revisionId = randomUUID();
  const now = Date.now();
  await database.transaction(async (database) => {
    if (input.rubricRevisionId) {
      const rubric = await database.prepare("SELECT id FROM rubric_revisions WHERE id = ?").get<{ id: string }>(input.rubricRevisionId);
      if (!rubric) throw new ApiError(404, "量表版本不存在");
    }
    await database.prepare("INSERT INTO benchmark_sets (id, name, description, status, current_revision, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?, ?)")
      .run(benchmarkId, input.name, input.description, user.id, now, now);
    await database.prepare("INSERT INTO benchmark_set_revisions (id, benchmark_set_id, revision, rubric_revision_id, content_hash, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)")
      .run(revisionId, benchmarkId, input.rubricRevisionId ?? null, hash({ benchmarkId, revision: 1, rubricRevisionId: input.rubricRevisionId ?? null }), user.id, now);
  })();
  return { id: benchmarkId, revisionId };
}

async function reviseBenchmark(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.benchmarkRevise.parse(payload);
  const revisionId = randomUUID();
  await database.transaction(async (database) => {
    const benchmark = await database.prepare("SELECT id, current_revision, status FROM benchmark_sets WHERE id = ? FOR UPDATE").get<{ id: string; current_revision: number; status: string }>(input.benchmarkId);
    if (!benchmark) throw new ApiError(404, "基准集不存在");
    if (benchmark.status === "retired") throw new ApiError(409, "已退役基准集不能修订");
    const previous = await database.prepare("SELECT rubric_revision_id FROM benchmark_set_revisions WHERE benchmark_set_id = ? AND revision = ?").get<{ rubric_revision_id: string | null }>(benchmark.id, benchmark.current_revision);
    const rubricRevisionId = input.rubricRevisionId === undefined ? previous?.rubric_revision_id ?? null : input.rubricRevisionId;
    if (rubricRevisionId) {
      const rubric = await database.prepare("SELECT id FROM rubric_revisions WHERE id = ?").get<{ id: string }>(rubricRevisionId);
      if (!rubric) throw new ApiError(404, "量表版本不存在");
    }
    const revision = benchmark.current_revision + 1;
    const now = Date.now();
    await database.prepare("INSERT INTO benchmark_set_revisions (id, benchmark_set_id, revision, rubric_revision_id, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(revisionId, benchmark.id, revision, rubricRevisionId, hash({ benchmarkId: benchmark.id, revision, rubricRevisionId }), user.id, now);
    await database.prepare("UPDATE benchmark_sets SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now, benchmark.id);
  })();
  return { id: input.benchmarkId, revisionId };
}

async function addBenchmarkItem(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.benchmarkAddItem.parse(payload);
  await database.transaction(async (database) => {
    const revision = await database.prepare("SELECT id FROM benchmark_set_revisions WHERE id = ? FOR UPDATE").get<{ id: string }>(input.benchmarkRevisionId);
    if (!revision) throw new ApiError(404, "基准集版本不存在");
    const report = await database.prepare("SELECT id, verdict, total_score, raw_json, created_at FROM evaluation_reports WHERE id = ?").get<{ id: string; verdict: string; total_score: number | null; raw_json: string; created_at: number }>(input.reportId);
    if (!report) throw new ApiError(404, "评估报告不存在");
    const position = await database.prepare("SELECT COALESCE(MAX(position), -1)::int + 1 AS position FROM benchmark_items WHERE benchmark_revision_id = ?").get<{ position: number }>(revision.id);
    await database.prepare("INSERT INTO benchmark_items (benchmark_revision_id, report_id, snapshot_hash, position) VALUES (?, ?, ?, ?)")
      .run(revision.id, report.id, hash({ reportId: report.id, verdict: report.verdict, totalScore: report.total_score, raw: report.raw_json, createdAt: report.created_at }), position?.position ?? 0);
  })();
  return { id: input.benchmarkRevisionId, reportId: input.reportId };
}

async function runBenchmark(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertApproverOrAdmin(user);
  const input = payloadSchemas.benchmarkRun.parse(payload);
  const runId = randomUUID();
  const now = Date.now();
  const result = await database.transaction(async (database) => {
    const revision = await database.prepare("SELECT id FROM benchmark_set_revisions WHERE id = ? FOR UPDATE").get<{ id: string }>(input.benchmarkRevisionId);
    if (!revision) throw new ApiError(404, "基准集版本不存在");
    await database.prepare("INSERT INTO benchmark_runs (id, benchmark_revision_id, status, model, result_json, started_by, created_at) VALUES (?, ?, 'running', ?, '{}', ?, ?)")
      .run(runId, revision.id, input.model, user.id, now);
    const reports = await database.prepare(`
      SELECT e.verdict, e.total_score FROM benchmark_items i JOIN evaluation_reports e ON e.id = i.report_id
      WHERE i.benchmark_revision_id = ? ORDER BY i.position
    `).all<{ verdict: string; total_score: number | null }>(revision.id);
    if (!reports.length) throw new ApiError(409, "基准集版本没有评估报告");
    const passed = reports.filter((report) => report.verdict === "pass").length;
    const scored = reports.filter((report) => report.total_score !== null);
    const summary = { total: reports.length, passed, passRate: passed / reports.length, averageScore: scored.length ? scored.reduce((sum, report) => sum + (report.total_score ?? 0), 0) / scored.length : null };
    const status = summary.passRate === 1 ? "passed" : "failed";
    await database.prepare("UPDATE benchmark_runs SET status = ?, result_json = ?, finished_at = ? WHERE id = ?").run(status, JSON.stringify(summary), Date.now(), runId);
    return { status, summary };
  })();
  return { id: runId, ...result };
}

async function evaluateGate(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertApproverOrAdmin(user);
  const input = payloadSchemas.gateEvaluate.parse(payload);
  const now = Date.now();
  const ids: string[] = [];
  await database.transaction(async (database) => {
    if (input.candidateId) {
      const candidate = await database.prepare("SELECT id FROM candidates WHERE id = ? FOR UPDATE").get<{ id: string }>(input.candidateId);
      if (!candidate) throw new ApiError(404, "候选不存在");
      const auto = await database.prepare(`
        SELECT id, verdict, created_at
        FROM candidate_reviews
        WHERE candidate_id = ? AND review_kind = 'auto'
        ORDER BY created_at DESC
        LIMIT 1
      `).get<{ id: string; verdict: string; created_at: number }>(candidate.id);
      const currentRound = await currentCandidateReviewRound(database, candidate.id);
      const content = currentRound?.reviews.get("content");
      const music = currentRound?.reviews.get("music");
      const gates = [
        { gateKey: "auto_qc", reviewKind: "auto", reviewId: auto?.id ?? null, verdict: auto?.verdict ?? null, reviewerId: null, automatic: true },
        { gateKey: "content_review", reviewKind: "content", reviewId: content?.id ?? null, verdict: content?.verdict ?? null, reviewerId: content?.reviewerId ?? null, automatic: false },
        { gateKey: "music_review", reviewKind: "music", reviewId: music?.id ?? null, verdict: music?.verdict ?? null, reviewerId: music?.reviewerId ?? null, automatic: false },
      ] as const;
      for (const gate of gates) {
        const verdict = gate.verdict === "pass" ? "pass" : gate.verdict ? "block" : "pending";
        const id = randomUUID();
        await database.prepare("INSERT INTO release_gate_checks (id, candidate_id, gate_key, verdict, evidence_json, checked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, candidate.id, gate.gateKey, verdict, JSON.stringify({
            reviewKind: gate.reviewKind,
            reviewId: gate.reviewId,
            reviewVerdict: gate.verdict,
            reviewerId: gate.reviewerId,
            reviewRoundId: gate.automatic ? null : currentRound?.id ?? null,
            reviewRoundNo: gate.automatic ? null : currentRound?.roundNo ?? null,
            reviewRoundStatus: gate.automatic ? null : currentRound?.status ?? null,
            automatic: gate.automatic,
          }), user.id, now);
        ids.push(id);
      }
    }
    if (input.publicationRevisionId) {
      const revision = await database.prepare("SELECT id FROM publication_revisions WHERE id = ?").get<{ id: string }>(input.publicationRevisionId);
      if (!revision) throw new ApiError(404, "出版版本不存在");
      const items = await database.prepare("SELECT COUNT(*)::int AS count FROM publication_items WHERE publication_revision_id = ?").get<{ count: number }>(revision.id);
      for (const gate of ["rights", "media_ready"] as const) {
        const verdict = (items?.count ?? 0) > 0 ? "pass" : "block";
        const id = randomUUID();
        await database.prepare("INSERT INTO release_gate_checks (id, publication_revision_id, gate_key, verdict, evidence_json, checked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, revision.id, gate, verdict, JSON.stringify({ itemCount: items?.count ?? 0, automatic: false }), user.id, now);
        ids.push(id);
      }
    }
  })();
  return { ids };
}

async function finalPassGate(database: HumDatabase, payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.gateFinalPass.parse(payload);
  const ids: string[] = [];
  await database.transaction(async (database) => {
    for (const subject of [{ column: "candidate_id", id: input.candidateId }, { column: "publication_revision_id", id: input.publicationRevisionId }] as const) {
      if (!subject.id) continue;
      const humanReview = subject.column === "candidate_id"
        ? await (async () => {
          const candidate = await database.prepare("SELECT id FROM candidates WHERE id = ? FOR UPDATE").get<{ id: string }>(subject.id);
          if (!candidate) throw new ApiError(404, "候选不存在");
          const auto = await database.prepare(`
            SELECT verdict
            FROM candidate_reviews
            WHERE candidate_id = ? AND review_kind = 'auto'
            ORDER BY created_at DESC
            LIMIT 1
          `).get<{ verdict: string }>(candidate.id);
          if (auto?.verdict !== "pass") throw new ApiError(409, "自动评分必须通过后才可终审；自动评分本身不构成批准");
          return requireCurrentCandidateHumanReviewRound(database, candidate.id);
        })()
        : null;
      const checks = await database.prepare(`SELECT gate_key, verdict, created_at FROM release_gate_checks WHERE ${subject.column} = ? AND gate_key <> 'final_approval' ORDER BY created_at DESC`).all<{ gate_key: string; verdict: string; created_at: number }>(subject.id);
      const latest = new Map<string, string>();
      for (const check of checks) if (!latest.has(check.gate_key)) latest.set(check.gate_key, check.verdict);
      const required = subject.column === "candidate_id" ? ["auto_qc"] : ["rights", "media_ready"];
      const missing = required.filter((gate) => latest.get(gate) !== "pass");
      if (missing.length) throw new ApiError(409, `终审前必须通过人工门禁：${missing.join(", ")}`);
      const id = randomUUID();
      const evidence = subject.column === "candidate_id"
        ? {
          required: ["auto_qc", "content_review", "music_review"],
          humanReview: {
            roundId: humanReview?.roundId,
            roundNo: humanReview?.roundNo,
            contentReviewerId: humanReview?.contentReviewerId,
            musicReviewerId: humanReview?.musicReviewerId,
            sameRound: true,
            distinctReviewers: true,
          },
          automaticPrecheckIsNotApproval: true,
        }
        : { required, automaticPrecheckIsNotApproval: true };
      await database.prepare(`INSERT INTO release_gate_checks (id, ${subject.column}, gate_key, verdict, evidence_json, checked_by, created_at) VALUES (?, ?, 'final_approval', 'pass', ?, ?, ?)` )
        .run(id, subject.id, JSON.stringify(evidence), user.id, Date.now());
      ids.push(id);
    }
  })();
  return { ids };
}

async function exportAudit(payload: unknown, user: SessionUser) {
  assertAdmin(user);
  const input = payloadSchemas.auditExport.parse(payload);
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new ApiError(400, "dateFrom 不能晚于 dateTo");
  const result = await listAudit({ resource: "audit", page: 1, pageSize: 100, reviewer: undefined, status: undefined, date: undefined, dateTo: input.dateTo, dateFrom: input.dateFrom, action: input.action, target: input.target, search: input.search });
  if (input.format === "json") return { format: "json", items: result.items, total: result.total };
  const columns = ["id", "actorUserId", "actorName", "action", "targetType", "targetId", "createdAt"] as const;
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return { format: "csv", csv: [columns.join(","), ...result.items.map((item) => columns.map((column) => escape((item as Record<string, unknown>)[column])).join(","))].join("\n"), total: result.total };
}

export async function actOnGovernance(input: unknown, user: SessionUser) {
  const request = governancePostSchema.parse(input);
  if (request.resource === "audit" && request.action === "export") {
    const result = await exportAudit(request.payload, user);
    await recordAudit(user.id, `governance.${request.resource}.${request.action}`, request.resource, request.resource, { payload: request.payload });
    return { ok: true, ...result };
  }

  const actions: Record<string, Record<string, (database: HumDatabase, payload: unknown, actor: SessionUser) => Promise<Record<string, unknown>>>> = {
    roles: { update: updateRole },
    rubrics: { create: createRubric, revise: reviseRubric, retire: retireRubric },
    rounds: { open: openRound, assign: assignRound, submit: submitRound, "request-changes": requestRoundChanges, close: closeRound },
    benchmarks: { create: createBenchmark, revise: reviseBenchmark, "add-item": addBenchmarkItem, run: runBenchmark },
    gates: { evaluate: evaluateGate, "final-pass": finalPassGate },
  };
  const handler = actions[request.resource]?.[request.action];
  if (!handler) throw new ApiError(400, "不支持的治理资源或操作");

  const result = await getDb().transaction(async (database) => {
    const result = await handler(database, request.payload, user);
    const targetId = Array.isArray(result.ids) ? result.ids.join(",") : String(result.id ?? request.resource);
    await recordAudit(user.id, `governance.${request.resource}.${request.action}`, request.resource, targetId, { payload: request.payload }, database);
    return result;
  })();
  return { ok: true, ...result };
}
