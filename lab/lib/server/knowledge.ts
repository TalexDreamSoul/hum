import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { recordAudit } from "./auth";
import { getDb, type HumDatabase } from "./database";

export const KNOWLEDGE_RESOURCES = ["items", "domains", "sources", "chapters", "curricula", "edges", "overview"] as const;
export type KnowledgeResource = (typeof KNOWLEDGE_RESOURCES)[number];
type KnowledgeRole = "admin" | "approver" | "uploader";
type Queryable = Pick<HumDatabase, "prepare">;

const idSchema = z.string().trim().min(1).max(160);
const slugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能使用小写字母、数字和连字符");
const textSchema = z.string().trim().max(8_000);
const metadataSchema = z.record(z.string().max(120), z.unknown()).refine((value) => JSON.stringify(value).length <= 24_000, "metadata 不能超过 24KB");
const itemContentSchema = z.object({
  title: textSchema.min(1).max(240),
  objective: textSchema.min(1).max(2_000),
  lead: textSchema.min(1).max(2_000),
  answer: textSchema.min(1).max(2_000),
  summary: textSchema.max(8_000).default(""),
  ageBand: z.string().trim().min(1).max(40),
  contentRisk: z.enum(["low", "medium", "high"]).default("low"),
  sourceRevisionId: idSchema.optional(),
  sourceLocator: z.string().trim().max(1_000).default(""),
});

const domainCreateSchema = z.object({ slug: slugSchema, name: textSchema.min(1).max(240), description: textSchema.max(4_000).default(""), parentId: idSchema.optional() }).strict();
const domainUpdateSchema = domainCreateSchema.partial().extend({ id: idSchema }).refine((value) => Object.keys(value).some((key) => key !== "id"), "至少提供一个待更新字段");
const domainStatusSchema = z.object({ id: idSchema, status: z.enum(["draft", "published", "retired"]) }).strict();
const sourceCreateSchema = z.object({
  sourceType: z.enum(["book", "article", "standard", "course", "manual", "original"]),
  title: textSchema.min(1).max(240),
  publisher: textSchema.max(240).default(""),
  versionLabel: textSchema.min(1).max(120),
  license: textSchema.min(1).max(240),
  excerpt: textSchema.max(8_000).default(""),
  metadata: metadataSchema.default({}),
}).strict();
const sourceReviseSchema = sourceCreateSchema.pick({ versionLabel: true, license: true, excerpt: true, metadata: true }).extend({ id: idSchema }).strict();
const sourceStatusSchema = z.object({ id: idSchema, status: z.enum(["draft", "review", "published", "retired"]) }).strict();
const chapterCreateSchema = z.object({ sourceRevisionId: idSchema, title: textSchema.min(1).max(240), locator: z.string().trim().max(1_000).default(""), position: z.number().int().min(0).optional(), excerpt: textSchema.max(8_000).default(""), parentId: idSchema.optional() }).strict();
const chapterReorderSchema = z.object({ sourceRevisionId: idSchema, chapters: z.array(z.object({ id: idSchema, position: z.number().int().min(0), parentId: idSchema.nullable().optional() }).strict()).min(1).max(500) }).strict();
const curriculumCreateSchema = z.object({ code: slugSchema, name: textSchema.min(1).max(240), ageBand: z.string().trim().min(1).max(40), description: textSchema.max(4_000).default(""), status: z.enum(["draft", "published", "retired"]).default("published") }).strict();
const curriculumBindSchema = z.object({ id: idSchema, itemRevisionId: idSchema, position: z.number().int().min(0) }).strict();
const itemCreateSchema = itemContentSchema.extend({ domainId: idSchema, slug: slugSchema }).strict();
const itemReviseSchema = itemContentSchema.extend({ id: idSchema }).strict();
const itemIdSchema = z.object({ id: idSchema }).strict();
const itemReviewSchema = z.object({ id: idSchema, verdict: z.enum(["pass", "revise", "reject"]), score: z.number().int().min(0).max(100).optional(), notes: textSchema.max(4_000).default(""), evidence: metadataSchema.default({}) }).strict();
const edgeCreateSchema = z.object({ fromRevisionId: idSchema, toRevisionId: idSchema, relation: z.enum(["sequence", "cause", "contrast", "classification", "condition", "result", "prerequisite"]), connector: z.string().trim().max(1_000).default("") }).strict();
const edgeDeleteSchema = z.object({ id: idSchema }).strict();
const mockPlanSchema = z.object({ domainId: idSchema, sourceRevisionId: idSchema.optional(), ageBand: z.string().trim().min(1).max(40).default("3-6"), theme: textSchema.min(1).max(240).optional() }).strict();

export const knowledgeQuerySchema = z.object({
  resource: z.enum(KNOWLEDGE_RESOURCES),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  domain: idSchema.optional(),
  status: z.string().trim().max(40).optional(),
  age: z.string().trim().max(40).optional(),
  source: idSchema.optional(),
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function asPage(page: number, pageSize: number, total: number) {
  return { page: Math.min(page, Math.max(1, Math.ceil(total / pageSize))), pageSize, total };
}

async function exists(database: Queryable, table: string, id: string, label: string) {
  const row = await database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get<{ id: string }>(id);
  if (!row) throw new ApiError(404, `${label}不存在`);
  return row;
}

async function assertDomain(database: Queryable, id: string) {
  return exists(database, "knowledge_domains", id, "知识域");
}

async function assertSourceRevision(database: Queryable, id: string) {
  return exists(database, "knowledge_source_revisions", id, "来源版本");
}

async function assertItemRevision(database: Queryable, id: string) {
  return exists(database, "knowledge_item_revisions", id, "知识条目版本");
}

async function nextPosition(database: Queryable, table: "knowledge_chapters" | "curriculum_items", column: "source_revision_id" | "curriculum_id", parentId: string | null, value: string) {
  const parentFilter = table === "knowledge_chapters" ? " AND parent_id IS NOT DISTINCT FROM ?" : "";
  const params = table === "knowledge_chapters" ? [value, parentId] : [value];
  return Number(await database.prepare(`SELECT COALESCE(MAX(position) + 1, 0) FROM ${table} WHERE ${column} = ?${parentFilter}`).pluck().get(...params) ?? 0);
}

async function assertItemContentAvailable(database: Queryable, domainId: string, title: string, answer: string, exceptItemId?: string) {
  const row = await database.prepare(`
    SELECT i.id, r.title, r.answer
    FROM knowledge_items i
    JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
    WHERE i.domain_id = ? AND (r.title = ? OR r.answer = ?)
    ${exceptItemId ? "AND i.id <> ?" : ""}
    LIMIT 1
  `).get<{ id: string; title: string; answer: string }>(...(exceptItemId ? [domainId, title, answer, exceptItemId] : [domainId, title, answer]));
  if (!row) return;
  if (row.title === title && row.answer === answer) throw new ApiError(409, "存在相同标题和答案的重复知识条目");
  throw new ApiError(409, row.title === title ? "存在标题相同但答案不同的冲突知识条目" : "存在答案相同但标题不同的冲突知识条目");
}

async function insertItemRevision(database: HumDatabase, input: z.infer<typeof itemContentSchema> & { itemId: string; revision: number }, userId: string) {
  if (input.sourceRevisionId) await assertSourceRevision(database, input.sourceRevisionId);
  const contentHash = hash({ ...input, itemId: undefined, revision: undefined });
  const duplicate = await database.prepare("SELECT id FROM knowledge_item_revisions WHERE content_hash = ?").get<{ id: string }>(contentHash);
  if (duplicate) throw new ApiError(409, "存在内容完全相同的知识版本");
  const revisionId = randomUUID();
  await database.prepare(`
    INSERT INTO knowledge_item_revisions (
      id, item_id, revision, title, objective, lead, answer, summary, age_band, content_risk,
      source_revision_id, source_locator, content_hash, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(revisionId, input.itemId, input.revision, input.title, input.objective, input.lead, input.answer, input.summary,
    input.ageBand, input.contentRisk, input.sourceRevisionId ?? null, input.sourceLocator, contentHash, userId, Date.now());
  return { revisionId, contentHash };
}



export function knowledgeActionRoles(resource: string, action: string): KnowledgeRole[] {
  if (resource === "items") {
    if (["create", "revise", "submit"].includes(action)) return ["admin", "uploader"];
    if (action === "review") return ["admin", "approver"];
    if (["publish", "retire"].includes(action)) return ["admin"];
  }
  if (resource === "sources" && ["create", "revise"].includes(action)) return ["admin", "uploader"];
  if (resource === "chapters" || resource === "edges" || (resource === "mock-plan")) return ["admin", "uploader"];
  return ["admin"];
}

export async function listKnowledge(input: z.infer<typeof knowledgeQuerySchema>) {
  const database = getDb();
  const { resource, pageSize, search, domain, status, age, source } = input;
  const page = input.page;
  const term = search ? `%${search}%` : undefined;
  let countSql = "";
  let listSql = "";
  let params: unknown[] = [];

  if (resource === "domains") {
    const where = [status ? "d.status = ?" : "", term ? "(d.name ILIKE ? OR d.slug ILIKE ? OR d.description ILIKE ?)" : ""].filter(Boolean);
    params = [status, ...(term ? [term, term, term] : [])].filter((value) => value !== undefined);
    countSql = `SELECT COUNT(*) FROM knowledge_domains d ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT d.id, d.parent_id AS "parentId", d.slug, d.name, d.description, d.status, d.revision, d.created_at AS "createdAt", d.updated_at AS "updatedAt" FROM knowledge_domains d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.name ASC, d.id ASC`;
  } else if (resource === "sources") {
    const where = [status ? "s.status = ?" : "", term ? "(s.title ILIKE ? OR s.publisher ILIKE ? OR s.source_type ILIKE ?)" : ""].filter(Boolean);
    params = [status, ...(term ? [term, term, term] : [])].filter((value) => value !== undefined);
    countSql = `SELECT COUNT(*) FROM knowledge_sources s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT s.id, s.source_type AS "sourceType", s.title, s.publisher, s.status, s.current_revision AS "currentRevision", r.id AS "revisionId", r.version_label AS "versionLabel", r.license, r.excerpt, r.metadata_json AS "metadataJson", r.content_hash AS "contentHash", s.created_at AS "createdAt", s.updated_at AS "updatedAt" FROM knowledge_sources s JOIN knowledge_source_revisions r ON r.source_id = s.id AND r.revision = s.current_revision ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.updated_at DESC, s.id DESC`;
  } else if (resource === "chapters") {
    const where = [source ? "c.source_revision_id = ?" : "", term ? "(c.title ILIKE ? OR c.locator ILIKE ? OR c.excerpt ILIKE ?)" : ""].filter(Boolean);
    params = [source, ...(term ? [term, term, term] : [])].filter((value) => value !== undefined);
    countSql = `SELECT COUNT(*) FROM knowledge_chapters c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT c.id, c.source_revision_id AS "sourceRevisionId", c.parent_id AS "parentId", c.title, c.locator, c.position, c.excerpt, c.content_hash AS "contentHash", c.created_at AS "createdAt" FROM knowledge_chapters c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.source_revision_id, c.position, c.id`;
  } else if (resource === "curricula") {
    const where = [status ? "c.status = ?" : "", age ? "c.age_band = ?" : "", term ? "(c.name ILIKE ? OR c.code ILIKE ? OR c.description ILIKE ?)" : ""].filter(Boolean);
    params = [status, age, ...(term ? [term, term, term] : [])].filter((value) => value !== undefined);
    countSql = `SELECT COUNT(*) FROM curricula c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT c.id, c.code, c.name, c.age_band AS "ageBand", c.description, c.status, c.created_at AS "createdAt", c.updated_at AS "updatedAt", COUNT(ci.item_revision_id)::int AS "itemCount" FROM curricula c LEFT JOIN curriculum_items ci ON ci.curriculum_id = c.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC`;
  } else if (resource === "edges") {
    const where = [domain ? "(from_item.domain_id = ? OR to_item.domain_id = ?)" : "", term ? "(e.connector ILIKE ? OR e.relation ILIKE ? OR from_revision.title ILIKE ? OR to_revision.title ILIKE ?)" : ""].filter(Boolean);
    params = [ ...(domain ? [domain, domain] : []), ...(term ? [term, term, term, term] : []) ];
    const joins = "JOIN knowledge_item_revisions from_revision ON from_revision.id = e.from_revision_id JOIN knowledge_item_revisions to_revision ON to_revision.id = e.to_revision_id JOIN knowledge_items from_item ON from_item.id = from_revision.item_id JOIN knowledge_items to_item ON to_item.id = to_revision.item_id";
    countSql = `SELECT COUNT(*) FROM knowledge_edges e ${joins} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT e.id, e.from_revision_id AS "fromRevisionId", e.to_revision_id AS "toRevisionId", e.relation, e.connector, from_revision.title AS "fromTitle", to_revision.title AS "toTitle", e.created_at AS "createdAt" FROM knowledge_edges e ${joins} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.created_at DESC, e.id DESC`;
  } else if (resource === "overview") {
    const counts = await Promise.all([
      database.prepare("SELECT COUNT(*) FROM knowledge_domains").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_sources").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_items").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_items WHERE status = 'draft'").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_items WHERE status = 'review'").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_items WHERE status = 'published'").pluck().get(),
      database.prepare("SELECT COUNT(*) FROM knowledge_edges").pluck().get(),
    ]);
    const items = ["domains", "sources", "items", "draftItems", "reviewItems", "publishedItems", "edges"].map((key, index) => ({ key, total: Number(counts[index] ?? 0) }));
    return { items, page: 1, pageSize: items.length, total: items.length };
  } else {
    const where = [domain ? "(i.domain_id = ? OR d.slug = ?)" : "", status ? "i.status = ?" : "", age ? "r.age_band = ?" : "", source ? "r.source_revision_id = ?" : "", term ? "(r.title ILIKE ? OR r.answer ILIKE ? OR r.lead ILIKE ? OR i.slug ILIKE ?)" : ""].filter(Boolean);
    params = [ ...(domain ? [domain, domain] : []), ...(status ? [status] : []), ...(age ? [age] : []), ...(source ? [source] : []), ...(term ? [term, term, term, term] : []) ];
    const joins = "JOIN knowledge_domains d ON d.id = i.domain_id JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision";
    countSql = `SELECT COUNT(*) FROM knowledge_items i ${joins} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    listSql = `SELECT i.id, i.domain_id AS "domainId", d.slug AS "domainSlug", d.name AS "domainName", i.slug, i.status, i.current_revision AS "currentRevision", r.id AS "revisionId", r.title, r.objective, r.lead, r.answer, r.summary, r.age_band AS "ageBand", r.content_risk AS "contentRisk", r.source_revision_id AS "sourceRevisionId", r.source_locator AS "sourceLocator", r.content_hash AS "contentHash", i.created_at AS "createdAt", i.updated_at AS "updatedAt" FROM knowledge_items i ${joins} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.updated_at DESC, i.id DESC`;
  }

  const total = Number(await database.prepare(countSql).pluck().get(...params) ?? 0);
  const paging = asPage(page, pageSize, total);
  const items = await database.prepare(`${listSql} LIMIT ? OFFSET ?`).all(...params, paging.pageSize, (paging.page - 1) * paging.pageSize);
  return { items, ...paging };
}

export async function executeKnowledgeAction(resource: string, action: string, payload: unknown, userId: string, actorRole: KnowledgeRole) {
  if (actorRole !== "admin" && actorRole !== "approver" && actorRole !== "uploader") {
    throw new ApiError(403, "无效的知识操作角色");
  }
  return getDb().transaction(async (database) => {
  let result: Record<string, unknown>;
  let audit: { action: string; targetType: string; targetId: string; detail: Record<string, unknown> };

  if (resource === "domains" && action === "create") {
    const input = domainCreateSchema.parse(payload);
    const id = randomUUID();
    await database.transaction(async (transaction) => {
      if (input.parentId) await assertDomain(transaction, input.parentId);
      await transaction.prepare("INSERT INTO knowledge_domains (id, parent_id, slug, name, description, status, revision, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").run(id, input.parentId ?? null, input.slug, input.name, input.description, userId, userId, Date.now(), Date.now());

    })();
    result = { domain: { id, ...input, status: "draft", revision: 1 } }; audit = { action: "knowledge.domain.create", targetType: "knowledge_domain", targetId: id, detail: { slug: input.slug } };
  } else if (resource === "domains" && action === "update") {
    const input = domainUpdateSchema.parse(payload);
    await database.transaction(async (transaction) => {
      const current = await transaction.prepare("SELECT * FROM knowledge_domains WHERE id = ? FOR UPDATE").get<{ id: string; slug: string; name: string; description: string; parent_id: string | null; revision: number }>(input.id);
      if (!current) throw new ApiError(404, "知识域不存在");
      if (input.parentId) {
        if (input.parentId === input.id) throw new ApiError(409, "知识域不能以自身为父级");
        await assertDomain(transaction, input.parentId);
      }
      await transaction.prepare("UPDATE knowledge_domains SET parent_id = ?, slug = ?, name = ?, description = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(input.parentId === undefined ? current.parent_id : input.parentId, input.slug ?? current.slug, input.name ?? current.name, input.description ?? current.description, current.revision + 1, userId, Date.now(), input.id);

    })();
    result = { id: input.id }; audit = { action: "knowledge.domain.update", targetType: "knowledge_domain", targetId: input.id, detail: {} };
  } else if (resource === "domains" && action === "status") {
    const input = domainStatusSchema.parse(payload);
    await database.transaction(async (transaction) => {
      await assertDomain(transaction, input.id);
      await transaction.prepare("UPDATE knowledge_domains SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(input.status, userId, Date.now(), input.id);

    })();
    result = { id: input.id, status: input.status }; audit = { action: "knowledge.domain.status", targetType: "knowledge_domain", targetId: input.id, detail: { status: input.status } };
  } else if (resource === "sources" && action === "create") {
    const input = sourceCreateSchema.parse(payload);
    const id = randomUUID(); const revisionId = randomUUID(); const contentHash = hash(input);
    await database.transaction(async (transaction) => {
      const duplicate = await transaction.prepare("SELECT id FROM knowledge_source_revisions WHERE content_hash = ?").get(contentHash);
      if (duplicate) throw new ApiError(409, "存在内容完全相同的来源版本");
      const now = Date.now();
      await transaction.prepare("INSERT INTO knowledge_sources (id, source_type, title, publisher, status, current_revision, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").run(id, input.sourceType, input.title, input.publisher, userId, userId, now, now);
      await transaction.prepare("INSERT INTO knowledge_source_revisions (id, source_id, revision, version_label, license, excerpt, metadata_json, content_hash, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)").run(revisionId, id, input.versionLabel, input.license, input.excerpt, stableJson(input.metadata), contentHash, userId, now);

    })();
    result = { source: { id, revisionId, currentRevision: 1, contentHash } }; audit = { action: "knowledge.source.create", targetType: "knowledge_source", targetId: id, detail: { revisionId, contentHash } };
  } else if (resource === "sources" && action === "revise") {
    const input = sourceReviseSchema.parse(payload);
    const revisionId = randomUUID();
    let revision = 0; let contentHash = "";
    await database.transaction(async (transaction) => {
      const source = await transaction.prepare("SELECT id, current_revision FROM knowledge_sources WHERE id = ? FOR UPDATE").get<{ id: string; current_revision: number }>(input.id);
      if (!source) throw new ApiError(404, "来源不存在");
      revision = source.current_revision + 1;
      contentHash = hash({ sourceId: input.id, revision, ...input });
      const duplicate = await transaction.prepare("SELECT id FROM knowledge_source_revisions WHERE content_hash = ?").get(contentHash);
      if (duplicate) throw new ApiError(409, "存在内容完全相同的来源版本");
      const now = Date.now();
      await transaction.prepare("INSERT INTO knowledge_source_revisions (id, source_id, revision, version_label, license, excerpt, metadata_json, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revisionId, input.id, revision, input.versionLabel, input.license, input.excerpt, stableJson(input.metadata), contentHash, userId, now);
      await transaction.prepare("UPDATE knowledge_sources SET current_revision = ?, status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?").run(revision, userId, now, input.id);

    })();
    result = { source: { id: input.id, revisionId, currentRevision: revision, contentHash, status: "draft" } }; audit = { action: "knowledge.source.revise", targetType: "knowledge_source", targetId: input.id, detail: { revisionId, revision, contentHash } };
  } else if (resource === "sources" && action === "status") {
    const input = sourceStatusSchema.parse(payload);
    await database.transaction(async (transaction) => {
      await exists(transaction, "knowledge_sources", input.id, "来源");
      await transaction.prepare("UPDATE knowledge_sources SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(input.status, userId, Date.now(), input.id);

    })();
    result = { id: input.id, status: input.status }; audit = { action: "knowledge.source.status", targetType: "knowledge_source", targetId: input.id, detail: { status: input.status } };
  } else if (resource === "chapters" && action === "create") {
    const input = chapterCreateSchema.parse(payload); const id = randomUUID(); let position = input.position;
    await database.transaction(async (transaction) => {
      await assertSourceRevision(transaction, input.sourceRevisionId);
      if (input.parentId) {
        const parent = await transaction.prepare("SELECT source_revision_id FROM knowledge_chapters WHERE id = ?").get<{ source_revision_id: string }>(input.parentId);
        if (!parent) throw new ApiError(404, "父章节不存在");
        if (parent.source_revision_id !== input.sourceRevisionId) throw new ApiError(409, "父章节必须属于同一来源版本");
      }
      position ??= await nextPosition(transaction, "knowledge_chapters", "source_revision_id", input.parentId ?? null, input.sourceRevisionId);
      const contentHash = hash({ ...input, position });
      await transaction.prepare("INSERT INTO knowledge_chapters (id, source_revision_id, parent_id, title, locator, position, excerpt, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.sourceRevisionId, input.parentId ?? null, input.title, input.locator, position, input.excerpt, contentHash, userId, Date.now());

    })();
    result = { chapter: { id, ...input, position } }; audit = { action: "knowledge.chapter.create", targetType: "knowledge_chapter", targetId: id, detail: { sourceRevisionId: input.sourceRevisionId, position } };
  } else if (resource === "chapters" && action === "reorder") {
    const input = chapterReorderSchema.parse(payload);
    await database.transaction(async (transaction) => {
      await assertSourceRevision(transaction, input.sourceRevisionId);
      const positions = new Set(input.chapters.map((chapter) => `${chapter.parentId ?? ""}:${chapter.position}`));
      if (positions.size !== input.chapters.length) throw new ApiError(409, "同一父章节下的位置不能重复");
      for (const chapter of input.chapters) {
        const current = await transaction.prepare("SELECT source_revision_id FROM knowledge_chapters WHERE id = ? FOR UPDATE").get<{ source_revision_id: string }>(chapter.id);
        if (!current) throw new ApiError(404, "章节不存在");
        if (current.source_revision_id !== input.sourceRevisionId) throw new ApiError(409, "章节必须属于指定来源版本");
        if (chapter.parentId) {
          const parent = await transaction.prepare("SELECT source_revision_id FROM knowledge_chapters WHERE id = ?").get<{ source_revision_id: string }>(chapter.parentId);
          if (!parent || parent.source_revision_id !== input.sourceRevisionId) throw new ApiError(409, "父章节必须属于同一来源版本");
        }
      }
      const temporaryOffset = 1_000_000;
      for (let index = 0; index < input.chapters.length; index += 1) await transaction.prepare("UPDATE knowledge_chapters SET position = ? WHERE id = ?").run(temporaryOffset + index, input.chapters[index].id);
      for (const chapter of input.chapters) await transaction.prepare("UPDATE knowledge_chapters SET parent_id = ?, position = ? WHERE id = ?").run(chapter.parentId ?? null, chapter.position, chapter.id);

    })();
    result = { sourceRevisionId: input.sourceRevisionId, count: input.chapters.length }; audit = { action: "knowledge.chapter.reorder", targetType: "knowledge_source_revision", targetId: input.sourceRevisionId, detail: { count: input.chapters.length } };
  } else if (resource === "curricula" && action === "create") {
    const input = curriculumCreateSchema.parse(payload); const id = randomUUID();
    await database.transaction(async (transaction) => {
      const now = Date.now();
      await transaction.prepare("INSERT INTO curricula (id, code, name, age_band, description, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.code, input.name, input.ageBand, input.description, input.status, userId, now, now);

    })();
    result = { curriculum: { id, ...input } }; audit = { action: "knowledge.curriculum.create", targetType: "curriculum", targetId: id, detail: { code: input.code } };
  } else if (resource === "curricula" && action === "bind") {
    const input = curriculumBindSchema.parse(payload);
    await database.transaction(async (transaction) => {
      await exists(transaction, "curricula", input.id, "课程");
      const revision = await transaction.prepare("SELECT i.status FROM knowledge_item_revisions r JOIN knowledge_items i ON i.id = r.item_id WHERE r.id = ?").get<{ status: string }>(input.itemRevisionId);
      if (!revision) throw new ApiError(404, "知识条目版本不存在");
      if (revision.status !== "published") throw new ApiError(409, "只能绑定已发布的知识条目版本");
      await transaction.prepare("INSERT INTO curriculum_items (curriculum_id, item_revision_id, position) VALUES (?, ?, ?) ON CONFLICT(curriculum_id, item_revision_id) DO UPDATE SET position = EXCLUDED.position").run(input.id, input.itemRevisionId, input.position);
      await transaction.prepare("UPDATE curricula SET updated_at = ? WHERE id = ?").run(Date.now(), input.id);

    })();
    result = { curriculumId: input.id, itemRevisionId: input.itemRevisionId, position: input.position }; audit = { action: "knowledge.curriculum.bind", targetType: "curriculum", targetId: input.id, detail: { itemRevisionId: input.itemRevisionId, position: input.position } };
  } else if (resource === "items" && action === "create") {
    const input = itemCreateSchema.parse(payload); const id = randomUUID(); let revisionId = ""; let contentHash = "";
    await database.transaction(async (transaction) => {
      await assertDomain(transaction, input.domainId);
      await assertItemContentAvailable(transaction, input.domainId, input.title, input.answer);
      const now = Date.now();
      await transaction.prepare("INSERT INTO knowledge_items (id, domain_id, slug, status, current_revision, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)").run(id, input.domainId, input.slug, userId, userId, now, now);
      ({ revisionId, contentHash } = await insertItemRevision(transaction, { ...input, itemId: id, revision: 1 }, userId));

    })();
    result = { item: { id, revisionId, currentRevision: 1, status: "draft", contentHash } }; audit = { action: "knowledge.item.create", targetType: "knowledge_item", targetId: id, detail: { revisionId, contentHash } };
  } else if (resource === "items" && action === "revise") {
    const input = itemReviseSchema.parse(payload); let revisionId = ""; let contentHash = ""; let revision = 0;
    await database.transaction(async (transaction) => {
      const item = await transaction.prepare("SELECT id, domain_id, current_revision, status, created_by FROM knowledge_items WHERE id = ? FOR UPDATE").get<{ id: string; domain_id: string; current_revision: number; status: string; created_by: string }>(input.id);
      if (!item) throw new ApiError(404, "知识条目不存在");
      if (actorRole === "uploader" && item.created_by !== userId) throw new ApiError(403, "只能修订自己创建的知识条目");
      if (actorRole === "uploader" && item.status !== "draft") throw new ApiError(409, "只能修订 draft 知识条目");
      await assertItemContentAvailable(transaction, item.domain_id, input.title, input.answer, item.id);
      revision = item.current_revision + 1;
      ({ revisionId, contentHash } = await insertItemRevision(transaction, { ...input, itemId: item.id, revision }, userId));
      const now = Date.now();
      await transaction.prepare("UPDATE knowledge_items SET current_revision = ?, status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?").run(revision, userId, now, item.id);

    })();
    result = { item: { id: input.id, revisionId, currentRevision: revision, status: "draft", contentHash } }; audit = { action: "knowledge.item.revise", targetType: "knowledge_item", targetId: input.id, detail: { revisionId, revision, contentHash } };
  } else if (resource === "items" && action === "submit") {
    const input = itemIdSchema.parse(payload);
    await database.transaction(async (transaction) => {
      const item = await transaction.prepare("SELECT status, created_by FROM knowledge_items WHERE id = ? FOR UPDATE").get<{ status: string; created_by: string }>(input.id);
      if (!item) throw new ApiError(404, "知识条目不存在");
      if (actorRole === "uploader" && item.created_by !== userId) throw new ApiError(403, "只能提交自己创建的知识条目");
      if (item.status !== "draft") throw new ApiError(409, "只有 draft 知识条目可以提交评审");
      await transaction.prepare("UPDATE knowledge_items SET status = 'review', updated_by = ?, updated_at = ? WHERE id = ?").run(userId, Date.now(), input.id);

    })();
    result = { id: input.id, status: "review" }; audit = { action: "knowledge.item.submit", targetType: "knowledge_item", targetId: input.id, detail: {} };
  } else if (resource === "items" && action === "review") {
    const input = itemReviewSchema.parse(payload);
    await database.transaction(async (transaction) => {
      const item = await transaction.prepare("SELECT status, current_revision FROM knowledge_items WHERE id = ? FOR UPDATE").get<{ status: string; current_revision: number }>(input.id);
      if (!item) throw new ApiError(404, "知识条目不存在");
      if (item.status !== "review") throw new ApiError(409, "只有 review 知识条目可以人工评审");
      const revision = await transaction.prepare("SELECT id FROM knowledge_item_revisions WHERE item_id = ? AND revision = ?").get<{ id: string }>(input.id, item.current_revision);
      if (!revision) throw new ApiError(409, "当前知识版本不存在");
      await transaction.prepare("INSERT INTO knowledge_reviews (id, item_revision_id, review_kind, verdict, score, notes, evidence_json, reviewer_id, created_at) VALUES (?, ?, 'content', ?, ?, ?, ?, ?, ?)").run(randomUUID(), revision.id, input.verdict, input.score ?? null, input.notes, stableJson(input.evidence), userId, Date.now());
      if (input.verdict !== "pass") await transaction.prepare("UPDATE knowledge_items SET status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?").run(userId, Date.now(), input.id);

    })();
    result = { id: input.id, verdict: input.verdict, status: input.verdict === "pass" ? "review" : "draft" }; audit = { action: "knowledge.item.review", targetType: "knowledge_item", targetId: input.id, detail: { verdict: input.verdict } };
  } else if (resource === "items" && ["publish", "retire"].includes(action)) {
    const input = itemIdSchema.parse(payload); const status = action === "publish" ? "published" : "retired";
    await database.transaction(async (transaction) => {
      const item = await transaction.prepare("SELECT status, current_revision FROM knowledge_items WHERE id = ? FOR UPDATE").get<{ status: string; current_revision: number }>(input.id);
      if (!item) throw new ApiError(404, "知识条目不存在");
      if (action === "publish") {
        if (item.status !== "review") throw new ApiError(409, "只有 review 知识条目可以发布");
        const review = await transaction.prepare("SELECT verdict FROM knowledge_reviews WHERE item_revision_id = (SELECT id FROM knowledge_item_revisions WHERE item_id = ? AND revision = ?) AND review_kind = 'content' ORDER BY created_at DESC LIMIT 1").get<{ verdict: string }>(input.id, item.current_revision);
        if (review?.verdict !== "pass") throw new ApiError(409, "当前知识版本需要通过人工评审后才能发布");
      }
      await transaction.prepare("UPDATE knowledge_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(status, userId, Date.now(), input.id);

    })();
    result = { id: input.id, status }; audit = { action: `knowledge.item.${action}`, targetType: "knowledge_item", targetId: input.id, detail: { status } };
  } else if (resource === "edges" && action === "create") {
    const input = edgeCreateSchema.parse(payload); const id = randomUUID();
    await database.transaction(async (transaction) => {
      if (input.fromRevisionId === input.toRevisionId) throw new ApiError(409, "关系不能指向自身");
      await assertItemRevision(transaction, input.fromRevisionId); await assertItemRevision(transaction, input.toRevisionId);
      await transaction.prepare("INSERT INTO knowledge_edges (id, from_revision_id, to_revision_id, relation, connector, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.fromRevisionId, input.toRevisionId, input.relation, input.connector, userId, Date.now());

    })();
    result = { edge: { id, ...input } }; audit = { action: "knowledge.edge.create", targetType: "knowledge_edge", targetId: id, detail: input };
  } else if (resource === "edges" && action === "delete") {
    const input = edgeDeleteSchema.parse(payload);
    await database.transaction(async (transaction) => {
      const deleted = await transaction.prepare("DELETE FROM knowledge_edges WHERE id = ?").run(input.id);
      if (!deleted.changes) throw new ApiError(404, "关系不存在");

    })();
    result = { id: input.id }; audit = { action: "knowledge.edge.delete", targetType: "knowledge_edge", targetId: input.id, detail: {} };
  } else if (resource === "mock-plan" && action === "create") {
    const input = mockPlanSchema.parse(payload); const basis = hash(input); const count = 3 + (parseInt(basis.slice(0, 2), 16) % 3); const itemIds: string[] = []; const edgeIds: string[] = [];
    await database.transaction(async (transaction) => {
      const domain = await transaction.prepare("SELECT id, name FROM knowledge_domains WHERE id = ? FOR UPDATE").get<{ id: string; name: string }>(input.domainId);
      if (!domain) throw new ApiError(404, "知识域不存在");
      if (input.sourceRevisionId) await assertSourceRevision(transaction, input.sourceRevisionId);
      for (let index = 0; index < count; index += 1) {
        const itemId = `mock-knowledge-${basis.slice(0, 16)}-${index + 1}`;
        const existing = await transaction.prepare("SELECT id, current_revision FROM knowledge_items WHERE id = ?").get<{ id: string; current_revision: number }>(itemId);
        let revisionId: string;
        if (existing) {
          const revision = await transaction.prepare("SELECT id FROM knowledge_item_revisions WHERE item_id = ? AND revision = ?").get<{ id: string }>(existing.id, existing.current_revision);
          if (!revision) throw new ApiError(409, "Mock 知识条目版本缺失");
          revisionId = revision.id;
        } else {
          const slug = `mock-${basis.slice(0, 12)}-${index + 1}`;
          const title = `${input.theme ?? domain.name} Mock 知识 ${index + 1}`;
          const answer = `Mock 答案 ${basis.slice(index * 4, index * 4 + 4)}`;
          await assertItemContentAvailable(transaction, domain.id, title, answer);
          const now = Date.now();
          await transaction.prepare("INSERT INTO knowledge_items (id, domain_id, slug, status, current_revision, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)").run(itemId, domain.id, slug, userId, userId, now, now);
          const created = await insertItemRevision(transaction, { itemId, revision: 1, title, objective: `认识${input.theme ?? domain.name}的 Mock 概念`, lead: `请说出 ${index + 1} 的答案`, answer, summary: "本地确定性 Mock 预筛草稿；不会自动发布。", ageBand: input.ageBand, contentRisk: "low", sourceRevisionId: input.sourceRevisionId, sourceLocator: `mock:${basis.slice(0, 12)}:${index + 1}` }, userId);
          revisionId = created.revisionId;
          const score = 70 + (parseInt(basis.slice(24 + index * 2, 26 + index * 2), 16) % 26);
          await transaction.prepare("INSERT INTO knowledge_reviews (id, item_revision_id, review_kind, verdict, score, notes, evidence_json, reviewer_id, created_at) VALUES (?, ?, 'mock_ai', 'pass', ?, ?, ?, NULL, ?)").run(randomUUID(), revisionId, score, "本地确定性 Mock AI 预筛；仍需人工评审。", stableJson({ mock: true, basis, automated: true }), Date.now());
        }
        itemIds.push(itemId);
        if (index > 0) {
          const previous = await transaction.prepare("SELECT id FROM knowledge_item_revisions WHERE item_id = ? AND revision = 1").get<{ id: string }>(itemIds[index - 1]);
          const edgeId = `mock-edge-${basis.slice(0, 16)}-${index}`;
          await transaction.prepare("INSERT INTO knowledge_edges (id, from_revision_id, to_revision_id, relation, connector, created_by, created_at) VALUES (?, ?, ?, 'sequence', ?, ?, ?) ON CONFLICT(from_revision_id, to_revision_id, relation) DO NOTHING").run(edgeId, previous?.id, revisionId, "Mock 逻辑顺序", userId, Date.now());
          edgeIds.push(edgeId);
        }
      }

    })();
    result = { plan: { basis, itemIds, edgeIds, count, status: "draft", automated: true } }; audit = { action: "knowledge.mock_plan.create", targetType: "knowledge_domain", targetId: input.domainId, detail: { count, itemIds, edgeIds, basis, automated: true } };
  } else {
    throw new ApiError(400, "不支持的知识资源或操作");
  }

  await recordAudit(userId, audit.action, audit.targetType, audit.targetId, audit.detail, database);
  return { ok: true, ...result };
  })();
}
