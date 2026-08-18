import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));

const SOURCE_TABLES = [
  "users",
  "sessions",
  "auth_attempts",
  "auth_identities",
  "oauth_states",
  "settings",
  "songs",
  "upload_grants",
  "source_materials",
  "song_specs",
  "experiment_batches",
  "candidates",
  "candidate_reviews",
  "approved_masters",
  "derived_tracks",
  "audit_log",
  "jobs",
];

function importedAgeBand(audience) {
  const normalized = String(audience || "").replace(/[–—至到]/g, "-");
  return ["3-4", "5-6", "7-8", "9-12"].find((value) => normalized.includes(value)) || normalized.slice(0, 80);
}

function importedDimensionVerdict(score) {
  if (score === null || score === undefined) return "info";
  if (score < 60) return "fail";
  if (score < 75) return "warning";
  return "pass";
}

async function backfillImportedReports(client) {
  const rows = await client.query(`
    SELECT r.candidate_id, r.verdict, r.notes, r.scores_json, r.created_at,
           c.provider, c.model, c.spec_id, c.prompt_snapshot_id,
           s.revision, s.content_hash, s.content_json,
           COALESCE(ps.skill_bundle_hash, '') AS skill_bundle_hash
    FROM candidate_reviews r
    JOIN candidates c ON c.id = r.candidate_id
    JOIN song_specs s ON s.id = c.spec_id
    LEFT JOIN prompt_snapshots ps ON ps.id = c.prompt_snapshot_id
    LEFT JOIN evaluation_reports e
      ON e.candidate_id = r.candidate_id AND e.report_kind = 'acoustic' AND e.evaluator = 'hum-dsp'
    WHERE r.review_kind = 'auto' AND e.id IS NULL
    ORDER BY r.created_at
  `);
  let inserted = 0;
  await client.query("BEGIN");
  try {
    for (const row of rows.rows) {
      let scores;
      let content;
      try {
        scores = JSON.parse(row.scores_json);
        content = JSON.parse(row.content_json);
      } catch {
        continue;
      }
      if (!scores?.analyzerVersion || !Array.isArray(scores.dims)) continue;
      const reportId = randomUUID();
      await client.query(`
        INSERT INTO evaluation_reports (
          id, subject_type, subject_id, candidate_id, song_id, report_kind, evaluator, evaluator_version,
          verdict, total_score, grade, domain, age_band, scene, provider, model,
          spec_id, spec_revision, spec_content_hash, prompt_snapshot_id, skill_bundle_hash,
          summary, raw_json, created_at
        ) VALUES ($1, 'candidate', $2, $2, NULL, 'acoustic', 'hum-dsp', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      `, [
        reportId, row.candidate_id, scores.analyzerVersion, row.verdict === "pass" ? "pass" : "fail",
        scores.total ?? null, scores.grade ?? "", content.domain ?? "", importedAgeBand(content.audience),
        scores.scene ?? content.scene ?? "general", row.provider, row.model, row.spec_id, row.revision,
        row.content_hash, row.prompt_snapshot_id, row.skill_bundle_hash, row.notes, row.scores_json, row.created_at,
      ]);
      for (const dimension of scores.dims) {
        await client.query(`
          INSERT INTO evaluation_dimensions (report_id, dimension_key, label, score, threshold, verdict, evidence_json)
          VALUES ($1, $2, $3, $4, NULL, $5, $6)
        `, [reportId, dimension.key, dimension.label, dimension.score ?? null, importedDimensionVerdict(dimension.score), JSON.stringify({ detail: dimension.detail, weight: dimension.weight })]);
      }
      inserted += 1;
    }
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const sourcePath = path.resolve(process.env.SQLITE_PATH || "local-data/hum.sqlite");
const connectionString = process.env.DATABASE_URL || "postgresql://hum:hum-local-only@127.0.0.1:55432/hum";
if (!existsSync(sourcePath)) throw new Error(`SQLite 源数据库不存在：${sourcePath}`);

const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
sqlite.pragma("query_only = ON");
const available = new Set(
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
);
const rowsByTable = new Map();
const sourceHash = createHash("sha256");
for (const table of SOURCE_TABLES) {
  const rows = available.has(table) ? sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() : [];
  rowsByTable.set(table, rows);
  sourceHash.update(table).update("\0").update(JSON.stringify(rows)).update("\0");
}
const fingerprint = sourceHash.digest("hex");
const counts = Object.fromEntries(SOURCE_TABLES.map((table) => [table, rowsByTable.get(table).length]));
const masterCandidateIds = new Set(rowsByTable.get("approved_masters").map((row) => row.candidate_id));
const originalCandidateStatuses = new Map(rowsByTable.get("candidates").map((row) => [row.id, row.status]));

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
const client = await pool.connect();
try {
  const schema = await client.query("SELECT to_regclass('public.schema_migrations') AS migrations, to_regclass('public.legacy_imports') AS imports");
  if (!schema.rows[0]?.migrations || !schema.rows[0]?.imports) {
    throw new Error("PostgreSQL schema 尚未初始化；请先启动 hum 让版本迁移完成");
  }
  const previous = await client.query("SELECT 1 FROM legacy_imports WHERE source_hash = $1", [fingerprint]);
  if (previous.rowCount) {
    console.log(`SQLite 数据已导入，跳过：${sourcePath}`);
    process.exitCode = 0;
  } else {
    const occupied = await client.query("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM song_specs) + (SELECT COUNT(*) FROM jobs) AS total");
    if (Number(occupied.rows[0]?.total || 0) > 0) {
      throw new Error("目标 PostgreSQL 已有业务数据且没有匹配的导入记录；拒绝合并两个数据源");
    }

    await client.query("BEGIN");
    try {
      for (const table of SOURCE_TABLES) {
        const rows = rowsByTable.get(table);
        for (const original of rows) {
          const row = { ...original };
          if (table === "candidates" && masterCandidateIds.has(row.id)) row.status = "generated";
          const columns = Object.keys(row);
          if (!columns.length) continue;
          const identifiers = columns.map((column) => `"${column}"`).join(", ");
          const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
          await client.query(
            `INSERT INTO "${table}" (${identifiers}) VALUES (${placeholders})`,
            columns.map((column) => row[column]),
          );
        }
      }

      for (const [candidateId, status] of originalCandidateStatuses) {
        if (masterCandidateIds.has(candidateId) && status !== "generated") {
          await client.query("UPDATE candidates SET status = $1 WHERE id = $2", [status, candidateId]);
        }
      }
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('audit_log', 'id'),
          COALESCE((SELECT MAX(id) FROM audit_log), 1),
          EXISTS(SELECT 1 FROM audit_log)
        )
      `);

      for (const table of SOURCE_TABLES) {
        const target = await client.query(`SELECT COUNT(*) AS count FROM "${table}"`);
        if (Number(target.rows[0].count) !== counts[table]) {
          throw new Error(`${table} 记录数不一致：SQLite=${counts[table]} PostgreSQL=${target.rows[0].count}`);
        }
      }
      await client.query(
        "INSERT INTO legacy_imports (source_hash, source_path, counts_json, imported_at) VALUES ($1, $2, $3, $4)",
        [fingerprint, sourcePath, JSON.stringify(counts), Date.now()],
      );
      await client.query("COMMIT");
      console.log(`SQLite 全量导入完成：${sourcePath}`);
      console.log(JSON.stringify(counts));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const backfilledReports = await backfillImportedReports(client);
  if (backfilledReports) console.log(`历史自动评分报告回填完成：${backfilledReports}`);
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
