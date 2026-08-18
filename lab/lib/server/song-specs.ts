import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./api";
import { getDb } from "./database";
import { createSongSpecSchema, songSpecContentSchema, type SongSpecContent } from "../song-spec";

export type SongSpecStatus = "draft" | "spec_review" | "approved" | "retired";

interface SongSpecRow {
  id: string;
  spec_key: string;
  revision: number;
  parent_id: string | null;
  source_material_id: string;
  status: SongSpecStatus;
  content_json: string;
  content_hash: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
}

export interface StoredSongSpec {
  id: string;
  specKey: string;
  revision: number;
  parentId: string | null;
  status: SongSpecStatus;
  contentHash: string;
  content: SongSpecContent;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  createdAt: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function mapSongSpec(row: SongSpecRow): StoredSongSpec {
  return {
    id: row.id,
    specKey: row.spec_key,
    revision: row.revision,
    parentId: row.parent_id,
    status: row.status,
    contentHash: row.content_hash,
    content: songSpecContentSchema.parse(JSON.parse(row.content_json)),
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

export async function getSongSpec(id: string) {
  const row = await getDb().prepare(`
    SELECT id, spec_key, revision, parent_id, source_material_id, status, content_json, content_hash,
           created_by, approved_by, approved_at, created_at
    FROM song_specs WHERE id = ?
  `).get(id) as SongSpecRow | undefined;
  if (!row) throw new ApiError(404, "SongSpec 不存在");
  return mapSongSpec(row);
}

export async function listSongSpecs() {
  const rows = await getDb().prepare(`
    SELECT id, spec_key, revision, parent_id, source_material_id, status, content_json, content_hash,
           created_by, approved_by, approved_at, created_at
    FROM song_specs ORDER BY created_at DESC, revision DESC LIMIT 200
  `).all() as SongSpecRow[];
  return rows.map(mapSongSpec);
}

export async function createSongSpec(input: unknown, userId: string) {
  const parsed = createSongSpecSchema.parse(input);
  const sourceHash = sha256(parsed.content.source.excerpt);
  if (sourceHash !== parsed.content.source.sourceHash) throw new ApiError(400, "sourceHash 与 source.excerpt 不匹配");

  const db = getDb();
  const now = Date.now();
  const contentJson = stableJson(parsed.content);
  const contentHash = sha256(contentJson);
  const id = randomUUID();

  await db.transaction(async (transaction) => {
    const latest = await transaction.prepare(`
      SELECT id, revision FROM song_specs WHERE spec_key = ? ORDER BY revision DESC LIMIT 1
    `).get(parsed.specKey) as { id: string; revision: number } | undefined;
  
    let revision = 1;
    if (parsed.parentId) {
      const parent = await transaction.prepare("SELECT id, spec_key, revision FROM song_specs WHERE id = ?").get(parsed.parentId) as
        | { id: string; spec_key: string; revision: number }
        | undefined;
      if (!parent) throw new ApiError(404, "父 SongSpec 不存在");
      if (parent.spec_key !== parsed.specKey) throw new ApiError(409, "父 SongSpec 与 specKey 不一致");
      if (!latest || latest.id !== parent.id) throw new ApiError(409, "只能从最新 revision 创建下一版");
      revision = parent.revision + 1;
    } else if (latest) {
      throw new ApiError(409, "该 specKey 已存在；新版本必须提供 parentId");
    }
  
    const sourceJson = stableJson(parsed.content.source);
    const existingSource = await transaction.prepare("SELECT id, content_json FROM source_materials WHERE source_hash = ?").get(sourceHash) as
      | { id: string; content_json: string }
      | undefined;
    if (existingSource && existingSource.content_json !== sourceJson) {
      throw new ApiError(409, "相同 sourceHash 的来源元数据不一致");
    }
    let sourceId = existingSource?.id;
    if (!sourceId) {
      sourceId = randomUUID();
      await transaction.prepare(`
        INSERT INTO source_materials (id, source_type, title, source_version, license, source_hash, content_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId,
      parsed.content.source.type,
      parsed.content.source.title,
      parsed.content.source.version,
      parsed.content.source.license,
      sourceHash,
      sourceJson,
      userId,
      now,);
    }
  
    await transaction.prepare(`
      INSERT INTO song_specs (
        id, spec_key, revision, parent_id, source_material_id, status,
        content_json, content_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, parsed.specKey, revision, parsed.parentId ?? null, sourceId, contentJson, contentHash, userId, now);
  })();

  return await getSongSpec(id);
}

export async function transitionSongSpec(id: string, action: "submit" | "approve" | "retire", userId: string) {
  const db = getDb();
  const current = await getSongSpec(id);
  const now = Date.now();

  if (action === "submit") {
    if (current.status !== "draft") throw new ApiError(409, "只有 draft 可以提交审核");
    await db.prepare("UPDATE song_specs SET status = 'spec_review' WHERE id = ?").run(id);
  } else if (action === "approve") {
    if (current.status !== "spec_review") throw new ApiError(409, "只有 spec_review 可以批准");
    await db.prepare("UPDATE song_specs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(userId, now, id);
  } else {
    if (current.status !== "approved") throw new ApiError(409, "只有 approved 可以退役");
    await db.prepare("UPDATE song_specs SET status = 'retired' WHERE id = ?").run(id);
  }

  return await getSongSpec(id);
}
