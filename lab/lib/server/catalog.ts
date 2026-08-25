import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb, type HumDatabase } from "./database";
import type { UserRole } from "./auth";

export const CATALOG_RESOURCES = ["publications", "tags", "rights", "releases", "imports", "overview"] as const;
export const PUBLICATION_KINDS = ["book", "album", "collection"] as const;
const PUBLICATION_ITEM_TYPES = ["knowledge", "song_spec", "media", "publication"] as const;
const RIGHTS_SUBJECT_TYPES = ["source", "publication", "media", "song_spec"] as const;
const TAG_CATEGORIES = ["audience", "scene", "theme", "domain", "format"] as const;
const IMPORT_KINDS = ["knowledge", "publication", "media"] as const;
const opaqueIdSchema = z.string().trim().min(1).max(160);

export type CatalogResource = (typeof CATALOG_RESOURCES)[number];
export type CatalogMutationInput = z.infer<typeof catalogMutationSchema>;

export const catalogQuerySchema = z.object({
  resource: z.enum(CATALOG_RESOURCES),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  kind: z.string().trim().max(40).optional(),
  status: z.string().trim().max(40).optional(),
  search: z.string().trim().max(120).optional(),
});

export const catalogMutationSchema = z.object({
  resource: z.enum(["publications", "tags", "rights", "releases", "imports"]),
  action: z.string().trim().min(1).max(40),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const publicationCreateSchema = z.object({
  kind: z.enum(PUBLICATION_KINDS),
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能包含小写字母、数字和连字符"),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).default(""),
  audience: z.string().trim().max(120).default(""),
  scene: z.string().trim().max(80).default("general"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const publicationReviseSchema = z.object({
  publicationId: opaqueIdSchema,
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4_000).optional(),
  audience: z.string().trim().max(120).optional(),
  scene: z.string().trim().max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((input) => input.title !== undefined || input.description !== undefined || input.audience !== undefined || input.scene !== undefined || input.metadata !== undefined, "至少提供一个修订字段");
const publicationItemSchema = z.object({
  publicationId: opaqueIdSchema,
  itemType: z.enum(PUBLICATION_ITEM_TYPES),
  itemId: opaqueIdSchema,
  label: z.string().trim().max(160).default(""),
});
const publicationRemoveItemSchema = z.object({ publicationId: opaqueIdSchema, itemId: opaqueIdSchema });
const publicationReorderSchema = z.object({ publicationId: opaqueIdSchema, itemIds: z.array(opaqueIdSchema).min(1).max(500) });
const publicationIdSchema = z.object({ publicationId: opaqueIdSchema });
const tagCreateSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能包含小写字母、数字和连字符"),
  name: z.string().trim().min(1).max(80),
  category: z.enum(TAG_CATEGORIES),
});
const tagBindSchema = z.object({ publicationId: opaqueIdSchema, tagId: opaqueIdSchema });
const rightCreateSchema = z.object({
  subjectType: z.enum(RIGHTS_SUBJECT_TYPES),
  subjectId: opaqueIdSchema,
  holder: z.string().trim().min(1).max(160),
  license: z.string().trim().min(1).max(240),
  territory: z.string().trim().max(120).default("global"),
  startsAt: z.coerce.number().int().nonnegative().optional(),
  expiresAt: z.coerce.number().int().nonnegative().optional(),
  evidence: z.string().trim().min(1).max(20_000),
}).refine((input) => input.expiresAt === undefined || input.startsAt === undefined || input.expiresAt > input.startsAt, "到期时间必须晚于生效时间");
const rightRevokeSchema = z.object({ rightId: opaqueIdSchema });
const releaseCreateSchema = z.object({ publicationId: opaqueIdSchema });
const releaseIdSchema = z.object({ releaseId: opaqueIdSchema });
const importValidateSchema = z.object({
  importKind: z.enum(IMPORT_KINDS),
  sourceName: z.string().trim().min(1).max(240),
  data: z.unknown(),
});
const importSchema = z.object({ batchId: opaqueIdSchema });

type Actor = { id: string; role: UserRole };
type PublicationRow = {
  id: string;
  kind: "book" | "album" | "collection";
  slug: string;
  title: string;
  description: string;
  status: "draft" | "review" | "published" | "retired";
  current_revision: number;
  audience: string;
  scene: string;
  created_by: string | null;
};
type RevisionRow = { id: string; revision: number; title: string; description: string; metadata_json: string; content_hash: string };
type PublicationItemRow = { id: string; item_type: (typeof PUBLICATION_ITEM_TYPES)[number]; item_id: string; position: number; label: string; snapshot_hash: string };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function hasServerVerifiedMediaContentHash(contentHashValue: string, metadataJson: string) {
  if (!/^[a-f0-9]{64}$/.test(contentHashValue)) return false;
  try {
    const metadata = JSON.parse(metadataJson) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const integrity = (metadata as Record<string, unknown>).integrity;
    if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) return false;
    const verification = (integrity as Record<string, unknown>).verification;
    return verification === "verified" || verification === "server";
  } catch {
    return false;
  }
}

function pageSql(page: number, pageSize: number) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload 必须是对象");
  return value as Record<string, unknown>;
}

function requireRole(actor: Actor, roles: UserRole[]) {
  if (!roles.includes(actor.role)) throw new ApiError(403, "没有执行此操作的权限");
}

function requireDraftOwner(publication: PublicationRow, actor: Actor) {
  if (publication.status !== "draft") throw new ApiError(409, "只有 draft 出版物可以编辑");
  if (actor.role === "uploader" && publication.created_by !== actor.id) throw new ApiError(403, "只能编辑自己创建的草稿");
}

async function recordAudit(database: HumDatabase, actorId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown>) {
  await database.prepare(`
    INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorId, action, targetType, targetId, stableJson(detail), Date.now());
}

async function publicationForUpdate(database: HumDatabase, publicationId: string): Promise<PublicationRow> {
  const row = await database.prepare(`
    SELECT id, kind, slug, title, description, status, current_revision, audience, scene, created_by
    FROM publications WHERE id = ? FOR UPDATE
  `).get(publicationId) as PublicationRow | undefined;
  if (!row) throw new ApiError(404, "出版物不存在");
  return row;
}

async function currentRevision(database: HumDatabase, publication: PublicationRow): Promise<RevisionRow> {
  const row = await database.prepare(`
    SELECT id, revision, title, description, metadata_json, content_hash
    FROM publication_revisions WHERE publication_id = ? AND revision = ?
    FOR UPDATE
  `).get(publication.id, publication.current_revision) as RevisionRow | undefined;
  if (!row) throw new ApiError(409, "出版物当前修订缺失");
  return row;
}

async function revisionItems(database: HumDatabase, revisionId: string): Promise<PublicationItemRow[]> {
  return await database.prepare(`
    SELECT id, item_type, item_id, position, label, snapshot_hash
    FROM publication_items WHERE publication_revision_id = ? ORDER BY position ASC
  `).all(revisionId) as PublicationItemRow[];
}

async function resolveItem(
  database: HumDatabase,
  itemType: PublicationItemRow["item_type"],
  itemId: string,
  visitedPublications: ReadonlySet<string> = new Set(),
) {
  if (itemType === "media") {
    const media = await database.prepare("SELECT content_hash, metadata_json FROM media_assets WHERE id = ? AND status = 'ready' FOR UPDATE").get<{ content_hash: string; metadata_json: string }>(itemId);
    if (!media || !hasServerVerifiedMediaContentHash(media.content_hash, media.metadata_json)) {
      throw new ApiError(409, "媒体尚未通过服务端完整性验证");
    }
    return media.content_hash;
  }

  let row: { content_hash: string } | undefined;
  if (itemType === "knowledge") {
    row = await database.prepare(`
      SELECT r.content_hash FROM knowledge_items i JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
      WHERE i.id = ? AND i.status = 'published'
    `).get(itemId) as { content_hash: string } | undefined;
  } else if (itemType === "song_spec") {
    row = await database.prepare("SELECT content_hash FROM song_specs WHERE id = ? AND status = 'approved'").get(itemId) as { content_hash: string } | undefined;
  } else {
    const publication = await publicationForUpdate(database, itemId);
    if (publication.status !== "published") throw new ApiError(409, "引用项不存在或尚未可发布");
    const normalized = await normalizeCurrentRevisionSnapshot(database, publication, undefined, visitedPublications);
    row = { content_hash: normalized.revision.content_hash };
  }
  if (!row) throw new ApiError(409, "引用项不存在或尚未可发布");
  return row.content_hash;
}

async function normalizeCurrentRevisionSnapshot(
  database: HumDatabase,
  publication: PublicationRow,
  expectedRevision?: Pick<RevisionRow, "id" | "revision">,
  visitedPublications: ReadonlySet<string> = new Set(),
) {
  if (visitedPublications.has(publication.id)) throw new ApiError(409, "出版物引用形成循环");
  const nestedVisited = new Set(visitedPublications);
  nestedVisited.add(publication.id);

  const revision = await currentRevision(database, publication);
  if (expectedRevision && (revision.id !== expectedRevision.id || revision.revision !== expectedRevision.revision)) {
    throw new ApiError(409, "发布包必须引用当前出版物修订");
  }

  const items = await revisionItems(database, revision.id);
  const canonicalItems: Array<{ itemType: PublicationItemRow["item_type"]; itemId: string; position: number; label: string; snapshotHash: string }> = [];
  for (const item of items) {
    const snapshotHash = await resolveItem(database, item.item_type, item.item_id, nestedVisited);
    if (snapshotHash !== item.snapshot_hash) {
      throw new ApiError(409, "出版物项快照已漂移，请创建新修订后重新通过发布门禁");
    }
    canonicalItems.push({ itemType: item.item_type, itemId: item.item_id, position: item.position, label: item.label, snapshotHash });
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(revision.metadata_json);
  } catch {
    throw new ApiError(409, "出版物当前修订快照无效");
  }
  const snapshot = { publicationId: publication.id, revision: revision.revision, title: revision.title, description: revision.description, metadata, items: canonicalItems };
  const snapshotHash = contentHash(snapshot);
  if (snapshotHash !== revision.content_hash) throw new ApiError(409, "出版物当前修订快照哈希不一致");
  return { revision, snapshotHash };
}

async function createRevision(database: HumDatabase, publication: PublicationRow, actorId: string, patch: { title?: string; description?: string; metadata?: Record<string, unknown> }, items: Array<Omit<PublicationItemRow, "id">>) {
  const previous = await currentRevision(database, publication);
  const revision = previous.revision + 1;
  const title = patch.title ?? previous.title;
  const description = patch.description ?? previous.description;
  const metadata = patch.metadata ?? JSON.parse(previous.metadata_json);
  const canonical = { publicationId: publication.id, revision, title, description, metadata, items: items.map(({ item_type, item_id, position, label, snapshot_hash }) => ({ itemType: item_type, itemId: item_id, position, label, snapshotHash: snapshot_hash })) };
  const revisionId = randomUUID();
  const now = Date.now();
  await database.prepare(`
    INSERT INTO publication_revisions (id, publication_id, revision, title, description, metadata_json, content_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(revisionId, publication.id, revision, title, description, stableJson(metadata), contentHash(canonical), actorId, now);
  for (const item of items) {
    await database.prepare(`
      INSERT INTO publication_items (id, publication_revision_id, item_type, item_id, position, label, snapshot_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), revisionId, item.item_type, item.item_id, item.position, item.label, item.snapshot_hash, now);
  }
  await database.prepare(`
    UPDATE publications SET current_revision = ?, title = ?, description = ?, updated_by = ?, updated_at = ? WHERE id = ?
  `).run(revision, title, description, actorId, now, publication.id);
  return { id: revisionId, revision, contentHash: contentHash(canonical) };
}

async function ensureActiveRights(database: HumDatabase, publicationId: string) {
  const now = Date.now();
  const right = await database.prepare(`
    SELECT id FROM rights_grants
    WHERE subject_type = 'publication' AND subject_id = ? AND status = 'valid'
      AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(publicationId, now, now) as { id: string } | undefined;
  if (!right) throw new ApiError(409, "发布需要有效的出版物版权授权");
  return right.id;
}

async function ensureReleaseGates(database: HumDatabase, revisionId: string, publicationId: string) {
  const items = await revisionItems(database, revisionId);
  if (!items.length) throw new ApiError(409, "发布包不能包含空内容");
  for (const item of items) await resolveItem(database, item.item_type, item.item_id);
  const rightId = await ensureActiveRights(database, publicationId);
  const finalApproval = await database.prepare(`
    SELECT c.id FROM release_gate_checks c JOIN users u ON u.id = c.checked_by
    WHERE c.publication_revision_id = ? AND c.gate_key = 'final_approval' AND c.verdict = 'pass' AND u.role = 'admin'
    ORDER BY c.created_at DESC LIMIT 1
  `).get(revisionId) as { id: string } | undefined;
  if (!finalApproval) throw new ApiError(409, "发布需要 A 级最终审核通过");
  return { itemCount: items.length, rightId, finalApprovalId: finalApproval.id };
}

async function createPublication(database: HumDatabase, actor: Actor, payload: unknown) {
  requireRole(actor, ["admin", "uploader"]);
  const input = publicationCreateSchema.parse(asRecord(payload));
  const now = Date.now();
  const id = randomUUID();
  const revisionId = randomUUID();
  const canonical = { publicationId: id, revision: 1, title: input.title, description: input.description, metadata: input.metadata, items: [] };
  await database.prepare(`
    INSERT INTO publications (id, kind, slug, title, description, status, current_revision, audience, scene, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?)
  `).run(id, input.kind, input.slug, input.title, input.description, input.audience, input.scene, actor.id, actor.id, now, now);
  await database.prepare(`
    INSERT INTO publication_revisions (id, publication_id, revision, title, description, metadata_json, content_hash, created_by, created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(revisionId, id, input.title, input.description, stableJson(input.metadata), contentHash(canonical), actor.id, now);
  await recordAudit(database, actor.id, "catalog.publication.create", "publication", id, { kind: input.kind, revision: 1, contentHash: contentHash(canonical) });
  return { publication: { id, kind: input.kind, slug: input.slug, status: "draft", currentRevision: 1 }, revision: { id: revisionId, contentHash: contentHash(canonical) } };
}

async function mutatePublication(database: HumDatabase, actor: Actor, action: string, payload: unknown) {
  if (action === "create") return createPublication(database, actor, payload);
  if (action === "revise") {
    requireRole(actor, ["admin", "uploader"]);
    const input = publicationReviseSchema.parse(asRecord(payload));
    const publication = await publicationForUpdate(database, input.publicationId);
    requireDraftOwner(publication, actor);
    const items = await revisionItems(database, (await currentRevision(database, publication)).id);
    const revision = await createRevision(database, publication, actor.id, { title: input.title, description: input.description, metadata: input.metadata }, items);
    if (input.audience !== undefined || input.scene !== undefined) await database.prepare("UPDATE publications SET audience = COALESCE(?, audience), scene = COALESCE(?, scene), updated_by = ?, updated_at = ? WHERE id = ?").run(input.audience ?? null, input.scene ?? null, actor.id, Date.now(), publication.id);
    await recordAudit(database, actor.id, "catalog.publication.revise", "publication", publication.id, revision);
    return { publicationId: publication.id, revision };
  }
  if (action === "add-item") {
    requireRole(actor, ["admin", "uploader"]);
    const input = publicationItemSchema.parse(asRecord(payload));
    const publication = await publicationForUpdate(database, input.publicationId);
    requireDraftOwner(publication, actor);
    if (input.itemType === "publication" && input.itemId === publication.id) throw new ApiError(400, "出版物不能引用自身");
    const current = await currentRevision(database, publication);
    const items = await revisionItems(database, current.id);
    if (items.some((item) => item.item_type === input.itemType && item.item_id === input.itemId)) throw new ApiError(409, "该内容已在出版物中");
    const snapshotHash = await resolveItem(database, input.itemType, input.itemId);
    const revision = await createRevision(database, publication, actor.id, {}, [...items, { item_type: input.itemType, item_id: input.itemId, position: items.length, label: input.label, snapshot_hash: snapshotHash }]);
    await recordAudit(database, actor.id, "catalog.publication.add_item", "publication", publication.id, { ...revision, itemType: input.itemType, itemId: input.itemId });
    return { publicationId: publication.id, revision };
  }
  if (action === "remove-item") {
    requireRole(actor, ["admin", "uploader"]);
    const input = publicationRemoveItemSchema.parse(asRecord(payload));
    const publication = await publicationForUpdate(database, input.publicationId);
    requireDraftOwner(publication, actor);
    const items = await revisionItems(database, (await currentRevision(database, publication)).id);
    const remaining = items.filter((item) => item.id !== input.itemId);
    if (remaining.length === items.length) throw new ApiError(404, "出版物项不存在");
    const revision = await createRevision(database, publication, actor.id, {}, remaining.map((item, position) => ({ ...item, position })));
    await recordAudit(database, actor.id, "catalog.publication.remove_item", "publication", publication.id, { ...revision, itemId: input.itemId });
    return { publicationId: publication.id, revision };
  }
  if (action === "reorder") {
    requireRole(actor, ["admin", "uploader"]);
    const input = publicationReorderSchema.parse(asRecord(payload));
    const publication = await publicationForUpdate(database, input.publicationId);
    requireDraftOwner(publication, actor);
    const items = await revisionItems(database, (await currentRevision(database, publication)).id);
    if (new Set(input.itemIds).size !== input.itemIds.length || input.itemIds.length !== items.length || items.some((item) => !input.itemIds.includes(item.id))) throw new ApiError(400, "排序必须恰好包含当前全部项目");
    const byId = new Map(items.map((item) => [item.id, item]));
    const revision = await createRevision(database, publication, actor.id, {}, input.itemIds.map((id, position) => ({ ...byId.get(id)!, position })));
    await recordAudit(database, actor.id, "catalog.publication.reorder", "publication", publication.id, revision);
    return { publicationId: publication.id, revision };
  }
  const input = publicationIdSchema.parse(asRecord(payload));
  const publication = await publicationForUpdate(database, input.publicationId);
  if (action === "submit") {
    requireRole(actor, ["admin", "uploader"]);
    requireDraftOwner(publication, actor);
    if (!(await revisionItems(database, (await currentRevision(database, publication)).id)).length) throw new ApiError(409, "空出版物不能提交审核");
    await database.prepare("UPDATE publications SET status = 'review', updated_by = ?, updated_at = ? WHERE id = ?").run(actor.id, Date.now(), publication.id);
  } else if (action === "publish") {
    requireRole(actor, ["admin"]);
    if (publication.status !== "review") throw new ApiError(409, "只有 review 出版物可以发布");
    const { revision } = await normalizeCurrentRevisionSnapshot(database, publication);
    await ensureReleaseGates(database, revision.id, publication.id);
    await database.prepare("UPDATE publications SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ?").run(actor.id, Date.now(), publication.id);
  } else if (action === "retire") {
    requireRole(actor, ["admin"]);
    if (publication.status !== "published") throw new ApiError(409, "只有 published 出版物可以退役");
    await database.prepare("UPDATE publications SET status = 'retired', updated_by = ?, updated_at = ? WHERE id = ?").run(actor.id, Date.now(), publication.id);
  } else throw new ApiError(400, "不支持的 publications action");
  await recordAudit(database, actor.id, `catalog.publication.${action}`, "publication", publication.id, { from: publication.status, to: action === "submit" ? "review" : action === "publish" ? "published" : "retired" });
  return { publicationId: publication.id, status: action === "submit" ? "review" : action === "publish" ? "published" : "retired" };
}

async function mutateTags(database: HumDatabase, actor: Actor, action: string, payload: unknown) {
  requireRole(actor, ["admin", "approver"]);
  if (action === "create") {
    const input = tagCreateSchema.parse(asRecord(payload));
    const id = randomUUID();
    await database.prepare("INSERT INTO content_tags (id, slug, name, category, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.slug, input.name, input.category, Date.now());
    await recordAudit(database, actor.id, "catalog.tag.create", "content_tag", id, input);
    return { tag: { id, ...input } };
  }
  if (action !== "bind") throw new ApiError(400, "不支持的 tags action");
  const input = tagBindSchema.parse(asRecord(payload));
  const publication = await publicationForUpdate(database, input.publicationId);
  if (publication.status === "retired") throw new ApiError(409, "退役出版物不能绑定标签");
  const tag = await database.prepare("SELECT id FROM content_tags WHERE id = ?").get(input.tagId) as { id: string } | undefined;
  if (!tag) throw new ApiError(404, "标签不存在");
  await database.prepare("INSERT INTO content_tag_bindings (tag_id, subject_type, subject_id) VALUES (?, 'publication', ?) ON CONFLICT DO NOTHING").run(input.tagId, publication.id);
  await recordAudit(database, actor.id, "catalog.tag.bind", "publication", publication.id, { tagId: input.tagId });
  return { publicationId: publication.id, tagId: input.tagId };
}

async function mutateRights(database: HumDatabase, actor: Actor, action: string, payload: unknown) {
  if (action === "create") {
    requireRole(actor, ["admin", "approver"]);
    const input = rightCreateSchema.parse(asRecord(payload));
    if (input.subjectType === "publication") await publicationForUpdate(database, input.subjectId);
    const id = randomUUID();
    const now = Date.now();
    await database.prepare(`
      INSERT INTO rights_grants (id, subject_type, subject_id, holder, license, territory, starts_at, expires_at, evidence_hash, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
    `).run(id, input.subjectType, input.subjectId, input.holder, input.license, input.territory, input.startsAt ?? null, input.expiresAt ?? null, contentHash(input.evidence), actor.id, now);
    await recordAudit(database, actor.id, "catalog.right.create", "rights_grant", id, { subjectType: input.subjectType, subjectId: input.subjectId, license: input.license, evidenceHash: contentHash(input.evidence) });
    return { right: { id, subjectType: input.subjectType, subjectId: input.subjectId, status: "valid" } };
  }
  if (action !== "revoke") throw new ApiError(400, "不支持的 rights action");
  requireRole(actor, ["admin"]);
  const input = rightRevokeSchema.parse(asRecord(payload));
  const row = await database.prepare("SELECT id, status FROM rights_grants WHERE id = ?").get(input.rightId) as { id: string; status: string } | undefined;
  if (!row) throw new ApiError(404, "版权授权不存在");
  if (row.status !== "valid") throw new ApiError(409, "只有有效授权可以撤销");
  await database.prepare("UPDATE rights_grants SET status = 'revoked' WHERE id = ?").run(row.id);
  await recordAudit(database, actor.id, "catalog.right.revoke", "rights_grant", row.id, { from: row.status, to: "revoked" });
  return { rightId: row.id, status: "revoked" };
}

async function releaseManifest(database: HumDatabase, releaseId: string) {
  const release = await database.prepare(`
    SELECT rp.id, rp.version, rp.status, rp.manifest_json, rp.content_hash, rp.gate_snapshot_json, rp.publication_revision_id,
           p.id AS publication_id, p.slug, p.kind, p.status AS publication_status, r.revision, r.title, r.description, r.metadata_json, r.content_hash AS revision_hash
    FROM release_packages rp JOIN publication_revisions r ON r.id = rp.publication_revision_id JOIN publications p ON p.id = r.publication_id
    WHERE rp.id = ?
    FOR UPDATE OF rp
  `).get(releaseId) as {
    id: string;
    version: number;
    status: string;
    manifest_json: string;
    content_hash: string;
    gate_snapshot_json: string;
    publication_revision_id: string;
    publication_id: string;
    slug: string;
    kind: string;
    publication_status: string;
    revision: number;
    title: string;
    description: string;
    metadata_json: string;
    revision_hash: string;
  } | undefined;
  if (!release) throw new ApiError(404, "发布包不存在");
  const items = await revisionItems(database, String(release.publication_revision_id));
  return { ...release, manifest: JSON.parse(String(release.manifest_json)), gates: JSON.parse(String(release.gate_snapshot_json)), items: items.map((item) => ({ id: item.id, itemType: item.item_type, itemId: item.item_id, position: item.position, label: item.label, snapshotHash: item.snapshot_hash })) };
}

async function mutateReleases(database: HumDatabase, actor: Actor, action: string, payload: unknown) {
  requireRole(actor, ["admin"]);
  if (action === "create") {
    const input = releaseCreateSchema.parse(asRecord(payload));
    const publication = await publicationForUpdate(database, input.publicationId);
    if (publication.status !== "published") throw new ApiError(409, "只能为已发布出版物创建发布包");
    const { revision, snapshotHash } = await normalizeCurrentRevisionSnapshot(database, publication);
    const latest = await database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM release_packages WHERE publication_revision_id = ?").get(revision.id) as { version: number };
    const version = Number(latest.version) + 1;
    const id = randomUUID();
    const manifest = { schema: "hum.catalog.release.v1", publication: { id: publication.id, slug: publication.slug, kind: publication.kind }, revision: { id: revision.id, revision: revision.revision, contentHash: snapshotHash }, createdAt: Date.now() };
    await database.prepare(`
      INSERT INTO release_packages (id, publication_revision_id, version, status, manifest_json, content_hash, gate_snapshot_json, created_by, created_at)
      VALUES (?, ?, ?, 'draft', ?, ?, '{}', ?, ?)
    `).run(id, revision.id, version, stableJson(manifest), contentHash(manifest), actor.id, Date.now());
    await recordAudit(database, actor.id, "catalog.release.create", "release_package", id, { publicationId: publication.id, revisionId: revision.id, version });
    return { release: { id, publicationId: publication.id, revisionId: revision.id, version, status: "draft" } };
  }
  const input = releaseIdSchema.parse(asRecord(payload));
  const release = await releaseManifest(database, input.releaseId);
  if (action === "release") {
    if (release.status !== "draft" && release.status !== "review") throw new ApiError(409, "只有 draft 或 review 发布包可以发布");
    const publication = await publicationForUpdate(database, String(release.publication_id));
    if (publication.status !== "published") throw new ApiError(409, "只能发布当前已发布出版物的发布包");
    const { revision, snapshotHash } = await normalizeCurrentRevisionSnapshot(database, publication, {
      id: String(release.publication_revision_id),
      revision: Number(release.revision),
    });
    const manifest = release.manifest as {
      schema?: unknown;
      publication?: { id?: unknown; slug?: unknown; kind?: unknown };
      revision?: { id?: unknown; revision?: unknown; contentHash?: unknown };
    };
    if (
      manifest?.schema !== "hum.catalog.release.v1"
      || manifest?.publication?.id !== publication.id
      || manifest?.publication?.slug !== publication.slug
      || manifest?.publication?.kind !== publication.kind
      || manifest?.revision?.id !== revision.id
      || manifest?.revision?.revision !== revision.revision
      || manifest?.revision?.contentHash !== snapshotHash
      || release.content_hash !== contentHash(manifest)
    ) {
      throw new ApiError(409, "发布包快照与当前出版物修订不一致");
    }
    const gates = await ensureReleaseGates(database, revision.id, publication.id);
    await database.prepare("UPDATE release_packages SET status = 'released', approved_by = ?, released_at = ?, gate_snapshot_json = ? WHERE id = ?").run(actor.id, Date.now(), stableJson(gates), input.releaseId);
    await recordAudit(database, actor.id, "catalog.release.release", "release_package", input.releaseId, gates);
    return { releaseId: input.releaseId, status: "released", gates };
  }
  if (action === "recall") {
    if (release.status !== "released") throw new ApiError(409, "只有已发布发布包可以撤回");
    await database.prepare("UPDATE release_packages SET status = 'recalled' WHERE id = ?").run(input.releaseId);
    await recordAudit(database, actor.id, "catalog.release.recall", "release_package", input.releaseId, { from: "released", to: "recalled" });
    return { releaseId: input.releaseId, status: "recalled" };
  }
  if (action === "preview") {
    await recordAudit(database, actor.id, "catalog.release.preview", "release_package", input.releaseId, { contentHash: release.content_hash });
    return { release };
  }
  if (action === "export") {
    const exported = { schema: "hum.catalog.export.v1", exportedAt: Date.now(), release };
    await recordAudit(database, actor.id, "catalog.release.export", "release_package", input.releaseId, { contentHash: contentHash(exported), schema: exported.schema });
    return { export: exported, contentHash: contentHash(exported) };
  }
  throw new ApiError(400, "不支持的 releases action");
}

function validateImportData(kind: z.infer<typeof importValidateSchema>["importKind"], data: unknown) {
  if (kind === "publication") {
    const parsed = z.object({
      kind: z.enum(PUBLICATION_KINDS), slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/), title: z.string().trim().min(1).max(160),
      description: z.string().trim().max(4_000).default(""), audience: z.string().trim().max(120).default(""), scene: z.string().trim().max(80).default("general"), metadata: z.record(z.string(), z.unknown()).default({}),
      items: z.array(z.object({ itemType: z.enum(PUBLICATION_ITEM_TYPES), itemId: opaqueIdSchema, label: z.string().trim().max(160).default(""), snapshotHash: z.string().min(1).max(128).optional() })).max(500).default([]),
    }).parse(data);
    return [parsed];
  }
  const parsed = z.array(z.record(z.string(), z.unknown())).min(1).max(1_000).parse(data);
  return parsed;
}

async function mutateImports(database: HumDatabase, actor: Actor, action: string, payload: unknown) {
  requireRole(actor, ["admin", "uploader"]);
  if (action === "validate") {
    const input = importValidateSchema.parse(asRecord(payload));
    const sourceHash = contentHash(input.data);
    const duplicate = await database.prepare("SELECT id, status FROM import_batches WHERE import_kind = ? AND source_hash = ?").get(input.importKind, sourceHash) as { id: string; status: string } | undefined;
    if (duplicate) return { batch: { id: duplicate.id, status: duplicate.status, deduplicated: true } };
    const id = randomUUID();
    const now = Date.now();
    try {
      const records = validateImportData(input.importKind, input.data);
      await database.prepare("INSERT INTO import_batches (id, import_kind, status, source_name, source_hash, summary_json, created_by, created_at, finished_at) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?)").run(id, input.importKind, input.sourceName, sourceHash, stableJson({ itemCount: records.length }), actor.id, now, now);
      for (const [index, record] of records.entries()) await database.prepare("INSERT INTO import_items (id, batch_id, row_no, status, payload_json, error) VALUES (?, ?, ?, 'valid', ?, '')").run(randomUUID(), id, index + 1, stableJson(record));
      await recordAudit(database, actor.id, "catalog.import.validate", "import_batch", id, { importKind: input.importKind, sourceHash, itemCount: records.length });
      return { batch: { id, importKind: input.importKind, status: "ready", itemCount: records.length, sourceHash } };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "导入数据无效";
      await database.prepare("INSERT INTO import_batches (id, import_kind, status, source_name, source_hash, summary_json, error, created_by, created_at, finished_at) VALUES (?, ?, 'failed', ?, ?, '{}', ?, ?, ?, ?)").run(id, input.importKind, input.sourceName, sourceHash, message, actor.id, now, now);
      await recordAudit(database, actor.id, "catalog.import.validate_failed", "import_batch", id, { importKind: input.importKind, sourceHash, error: message });
      throw error;
    }
  }
  if (action !== "import") throw new ApiError(400, "不支持的 imports action");
  const input = importSchema.parse(asRecord(payload));
  const batch = await database.prepare("SELECT id, import_kind, status, created_by FROM import_batches WHERE id = ?").get(input.batchId) as { id: string; import_kind: "knowledge" | "publication" | "media"; status: string; created_by: string | null } | undefined;
  if (!batch) throw new ApiError(404, "导入批次不存在");
  if (batch.status !== "ready") throw new ApiError(409, "只有验证通过的批次可以导入");
  if (actor.role === "uploader" && batch.created_by !== actor.id) throw new ApiError(403, "只能导入自己创建的批次");
  if (batch.import_kind !== "publication") throw new ApiError(409, "当前仅支持出版物 JSON 导入");
  const rows = await database.prepare("SELECT id, row_no, payload_json FROM import_items WHERE batch_id = ? AND status = 'valid' ORDER BY row_no ASC").all(batch.id) as Array<{ id: string; row_no: number; payload_json: string }>;
  const imported: string[] = [];
  for (const row of rows) {
    const data = publicationCreateSchema.parse(JSON.parse(row.payload_json));
    const existing = await database.prepare("SELECT id FROM publications WHERE slug = ?").get(data.slug) as { id: string } | undefined;
    if (existing) throw new ApiError(409, `slug 已存在：${data.slug}`);
    const created = await createPublication(database, actor, data);
    const itemRows = (JSON.parse(row.payload_json) as { items?: Array<{ itemType: PublicationItemRow["item_type"]; itemId: string; label?: string }> }).items ?? [];
    for (const item of itemRows) await mutatePublication(database, actor, "add-item", { publicationId: created.publication.id, itemType: item.itemType, itemId: item.itemId, label: item.label ?? "" });
    await database.prepare("UPDATE import_items SET status = 'imported' WHERE id = ?").run(row.id);
    imported.push(created.publication.id);
  }
  await database.prepare("UPDATE import_batches SET status = 'imported', summary_json = ?, finished_at = ? WHERE id = ?").run(stableJson({ importedPublicationIds: imported }), Date.now(), batch.id);
  await recordAudit(database, actor.id, "catalog.import.import", "import_batch", batch.id, { importedPublicationIds: imported });
  return { batchId: batch.id, status: "imported", publicationIds: imported };
}

export async function executeCatalogMutation(input: CatalogMutationInput, actor: Actor) {
  return await getDb().transaction(async (database) => {
    let result: Record<string, unknown>;
    if (input.resource === "publications") result = await mutatePublication(database, actor, input.action, input.payload);
    else if (input.resource === "tags") result = await mutateTags(database, actor, input.action, input.payload);
    else if (input.resource === "rights") result = await mutateRights(database, actor, input.action, input.payload);
    else if (input.resource === "releases") result = await mutateReleases(database, actor, input.action, input.payload);
    else result = await mutateImports(database, actor, input.action, input.payload);
    return { ok: true, resource: input.resource, action: input.action, ...result };
  })();
}

export async function listCatalog(query: z.infer<typeof catalogQuerySchema>) {
  const database = getDb();
  const { limit, offset } = pageSql(query.page, query.pageSize);
  const search = query.search ? `%${query.search.replace(/[\\%_]/g, "\\$&")}%` : null;
  if (query.resource === "publications") {
    const filters = ["1 = 1"]; const params: unknown[] = [];
    if (query.kind) { filters.push("p.kind = ?"); params.push(query.kind); }
    if (query.status) { filters.push("p.status = ?"); params.push(query.status); }
    if (search) { filters.push("(p.title ILIKE ? ESCAPE '\\\\' OR p.slug ILIKE ? ESCAPE '\\\\' OR p.description ILIKE ? ESCAPE '\\\\')"); params.push(search, search, search); }
    const where = filters.join(" AND ");
    const count = await database.prepare(`SELECT COUNT(*)::int AS total FROM publications p WHERE ${where}`).get(...params) as { total: number };
    const items = await database.prepare(`
      SELECT p.id, p.kind, p.slug, p.title, p.description, p.status, p.current_revision AS "currentRevision", p.audience, p.scene, p.created_at AS "createdAt", p.updated_at AS "updatedAt", r.content_hash AS "contentHash",
             (SELECT COUNT(*)::int FROM publication_items pi WHERE pi.publication_revision_id = r.id) AS "itemCount"
      FROM publications p JOIN publication_revisions r ON r.publication_id = p.id AND r.revision = p.current_revision
      WHERE ${where} ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { items, page: query.page, pageSize: query.pageSize, total: Number(count.total) };
  }
  if (query.resource === "tags") {
    const filters = ["1 = 1"]; const params: unknown[] = [];
    if (query.kind) { filters.push("t.category = ?"); params.push(query.kind); }
    if (search) { filters.push("(t.slug ILIKE ? ESCAPE '\\\\' OR t.name ILIKE ? ESCAPE '\\\\')"); params.push(search, search); }
    const where = filters.join(" AND ");
    const count = await database.prepare(`SELECT COUNT(*)::int AS total FROM content_tags t WHERE ${where}`).get(...params) as { total: number };
    const items = await database.prepare(`SELECT t.id, t.slug, t.name, t.category, t.created_at AS "createdAt", (SELECT COUNT(*)::int FROM content_tag_bindings b WHERE b.tag_id = t.id) AS "bindingCount" FROM content_tags t WHERE ${where} ORDER BY t.name ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items, page: query.page, pageSize: query.pageSize, total: Number(count.total) };
  }
  if (query.resource === "rights") {
    const filters = ["1 = 1"]; const params: unknown[] = [];
    if (query.kind) { filters.push("r.subject_type = ?"); params.push(query.kind); }
    if (query.status) { filters.push("r.status = ?"); params.push(query.status); }
    if (search) { filters.push("(r.holder ILIKE ? ESCAPE '\\\\' OR r.license ILIKE ? ESCAPE '\\\\' OR r.subject_id::text ILIKE ? ESCAPE '\\\\')"); params.push(search, search, search); }
    const where = filters.join(" AND ");
    const count = await database.prepare(`SELECT COUNT(*)::int AS total FROM rights_grants r WHERE ${where}`).get(...params) as { total: number };
    const items = await database.prepare(`SELECT r.id, r.subject_type AS "subjectType", r.subject_id AS "subjectId", r.holder, r.license, r.territory, r.starts_at AS "startsAt", r.expires_at AS "expiresAt", r.evidence_hash AS "evidenceHash", r.status, r.created_at AS "createdAt" FROM rights_grants r WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items, page: query.page, pageSize: query.pageSize, total: Number(count.total) };
  }
  if (query.resource === "releases") {
    const filters = ["1 = 1"]; const params: unknown[] = [];
    if (query.kind) { filters.push("p.kind = ?"); params.push(query.kind); }
    if (query.status) { filters.push("rp.status = ?"); params.push(query.status); }
    if (search) { filters.push("(p.title ILIKE ? ESCAPE '\\\\' OR p.slug ILIKE ? ESCAPE '\\\\')"); params.push(search, search); }
    const where = filters.join(" AND ");
    const count = await database.prepare(`SELECT COUNT(*)::int AS total FROM release_packages rp JOIN publication_revisions r ON r.id = rp.publication_revision_id JOIN publications p ON p.id = r.publication_id WHERE ${where}`).get(...params) as { total: number };
    const items = await database.prepare(`SELECT rp.id, rp.version, rp.status, rp.content_hash AS "contentHash", rp.created_at AS "createdAt", rp.released_at AS "releasedAt", p.id AS "publicationId", p.kind, p.slug, p.title, r.revision FROM release_packages rp JOIN publication_revisions r ON r.id = rp.publication_revision_id JOIN publications p ON p.id = r.publication_id WHERE ${where} ORDER BY rp.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items, page: query.page, pageSize: query.pageSize, total: Number(count.total) };
  }
  if (query.resource === "imports") {
    const filters = ["1 = 1"]; const params: unknown[] = [];
    if (query.kind) { filters.push("b.import_kind = ?"); params.push(query.kind); }
    if (query.status) { filters.push("b.status = ?"); params.push(query.status); }
    if (search) { filters.push("b.source_name ILIKE ? ESCAPE '\\\\'"); params.push(search); }
    const where = filters.join(" AND ");
    const count = await database.prepare(`SELECT COUNT(*)::int AS total FROM import_batches b WHERE ${where}`).get(...params) as { total: number };
    const items = await database.prepare(`SELECT b.id, b.import_kind AS "importKind", b.status, b.source_name AS "sourceName", b.source_hash AS "sourceHash", b.summary_json AS "summary", b.error, b.created_at AS "createdAt", b.finished_at AS "finishedAt" FROM import_batches b WHERE ${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items, page: query.page, pageSize: query.pageSize, total: Number(count.total) };
  }
  const rows = await database.prepare(`
    SELECT 'publications' AS resource, COUNT(*)::int AS total FROM publications
    UNION ALL SELECT 'tags', COUNT(*)::int FROM content_tags
    UNION ALL SELECT 'rights', COUNT(*)::int FROM rights_grants
    UNION ALL SELECT 'releases', COUNT(*)::int FROM release_packages
    UNION ALL SELECT 'imports', COUNT(*)::int FROM import_batches
  `).all();
  return { items: rows, page: query.page, pageSize: query.pageSize, total: rows.length };
}
