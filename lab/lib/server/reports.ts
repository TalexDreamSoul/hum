import "server-only";

import { randomUUID } from "node:crypto";
import type { SceneKey } from "../analysis/score";
import type { CandidateAutoAssessment } from "./candidate-analysis";
import type { LyricStructureAssessment } from "../song-spec";
import { ApiError } from "./api";
import { getDb, type HumDatabase } from "./database";

export interface ReportFilters {
  page?: number;
  pageSize?: number;
  verdict?: "pass" | "fail" | "warning" | "info";
  minScore?: number;
  maxScore?: number;
  dimension?: string;
  dimensionMax?: number;
  domain?: string;
  ageBand?: string;
  scene?: string;
  model?: string;
  search?: string;
}

export interface EvaluationReportSummary {
  id: string;
  subjectType: "candidate" | "song";
  subjectId: string;
  subjectTitle: string;
  reportKind: string;
  evaluator: string;
  evaluatorVersion: string;
  verdict: "pass" | "fail" | "warning" | "info";
  totalScore: number | null;
  grade: string;
  domain: string;
  ageBand: string;
  scene: string;
  provider: string;
  model: string;
  specId: string | null;
  specRevision: number | null;
  promptSnapshotId: string | null;
  createdAt: number;
}

interface ReportRow extends EvaluationReportSummary {
  rawJson: string;
  summary: string;
  specContentJson: string | null;
  specContentHash: string;
  prompt: string | null;
  lyrics: string | null;
  requestJson: string | null;
  builderVersion: string | null;
  tuningId: string | null;
  skillBundleHash: string;
}

function ageBandOf(audience: string): string {
  const normalized = audience.replace(/[–—至到]/g, "-");
  for (const value of ["3-4", "5-6", "7-8", "9-12"]) {
    if (normalized.includes(value)) return value;
  }
  return audience.slice(0, 80);
}

function dimensionVerdict(score: number | null): "pass" | "fail" | "warning" | "info" {
  if (score === null) return "info";
  if (score < 60) return "fail";
  if (score < 75) return "warning";
  return "pass";
}

async function insertDimensions(database: HumDatabase, reportId: string, assessment: CandidateAutoAssessment): Promise<void> {
  for (const dimension of assessment.scores.dims) {
    await database.prepare(`
      INSERT INTO evaluation_dimensions (
        report_id, dimension_key, label, score, threshold, verdict, evidence_json
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(report_id, dimension_key) DO NOTHING
    `).run(
      reportId,
      dimension.key,
      dimension.label,
      dimension.score,
      dimensionVerdict(dimension.score),
      JSON.stringify({ detail: dimension.detail, weight: dimension.weight }),
    );
  }
}

export async function saveCandidateEvaluation(
  database: HumDatabase,
  candidateId: string,
  assessment: CandidateAutoAssessment,
): Promise<string> {
  const source = await database.prepare(`
    SELECT c.id, c.provider, c.model, c.spec_id, c.prompt_snapshot_id,
           s.revision, s.content_hash, s.content_json, COALESCE(ps.skill_bundle_hash, '') AS skill_bundle_hash
    FROM candidates c JOIN song_specs s ON s.id = c.spec_id
    LEFT JOIN prompt_snapshots ps ON ps.id = c.prompt_snapshot_id
    WHERE c.id = ?
  `).get(candidateId) as {
    id: string;
    provider: string;
    model: string;
    spec_id: string;
    prompt_snapshot_id: string | null;
    skill_bundle_hash: string;
    revision: number;
    content_hash: string;
    content_json: string;
  } | undefined;
  if (!source) throw new ApiError(404, "候选不存在，无法保存评分报告");
  const existing = await database.prepare(`
    SELECT id FROM evaluation_reports
    WHERE candidate_id = ? AND report_kind = 'acoustic' AND evaluator = 'hum-dsp' AND evaluator_version = ?
  `).get(candidateId, assessment.scores.analyzerVersion) as { id: string } | undefined;
  if (existing) return existing.id;

  const content = JSON.parse(source.content_json) as {
    title?: string;
    domain?: string;
    audience?: string;
  };
  const reportId = randomUUID();
  await database.prepare(`
    INSERT INTO evaluation_reports (
      id, subject_type, subject_id, candidate_id, song_id, report_kind, evaluator, evaluator_version,
      verdict, total_score, grade, domain, age_band, scene, provider, model,
      spec_id, spec_revision, spec_content_hash, prompt_snapshot_id, skill_bundle_hash,
      summary, raw_json, created_at
    ) VALUES (?, 'candidate', ?, ?, NULL, 'acoustic', 'hum-dsp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    candidateId,
    candidateId,
    assessment.scores.analyzerVersion,
    assessment.passed ? "pass" : "fail",
    assessment.scores.total,
    assessment.scores.grade ?? "",
    content.domain ?? "",
    ageBandOf(content.audience ?? ""),
    assessment.scores.scene,
    source.provider,
    source.model,
    source.spec_id,
    source.revision,
    source.content_hash,
    source.prompt_snapshot_id,
    source.skill_bundle_hash,
    assessment.notes,
    JSON.stringify(assessment.scores),
    Date.now(),
  );
  await insertDimensions(database, reportId, assessment);
  return reportId;
}

export async function saveCandidateLyricEvaluation(
  database: HumDatabase,
  candidateId: string,
  assessment: LyricStructureAssessment,
): Promise<string> {
  const source = await database.prepare(`
    SELECT c.id, c.provider, c.model, c.spec_id, c.prompt_snapshot_id,
           s.revision, s.content_hash, s.content_json, COALESCE(ps.skill_bundle_hash, '') AS skill_bundle_hash
    FROM candidates c JOIN song_specs s ON s.id = c.spec_id
    LEFT JOIN prompt_snapshots ps ON ps.id = c.prompt_snapshot_id
    WHERE c.id = ?
  `).get(candidateId) as {
    provider: string; model: string; spec_id: string; prompt_snapshot_id: string | null; skill_bundle_hash: string;
    revision: number; content_hash: string; content_json: string;
  } | undefined;
  if (!source) throw new ApiError(404, "候选不存在，无法保存歌词评测");
  const existing = await database.prepare(`
    SELECT id FROM evaluation_reports
    WHERE candidate_id = ? AND report_kind = 'lyric' AND evaluator = 'hum-lyric-structure' AND evaluator_version = '1'
  `).get(candidateId) as { id: string } | undefined;
  if (existing) return existing.id;

  const content = JSON.parse(source.content_json) as { domain?: string; audience?: string; scene?: SceneKey };
  const reportId = randomUUID();
  await database.prepare(`
    INSERT INTO evaluation_reports (
      id, subject_type, subject_id, candidate_id, song_id, report_kind, evaluator, evaluator_version,
      verdict, total_score, grade, domain, age_band, scene, provider, model,
      spec_id, spec_revision, spec_content_hash, prompt_snapshot_id, skill_bundle_hash, summary, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportId, "candidate", candidateId, candidateId, null, "lyric", "hum-lyric-structure", "1",
    assessment.passed ? "pass" : "fail", assessment.total, "", content.domain ?? "", ageBandOf(content.audience ?? ""),
    content.scene ?? "general", source.provider, source.model, source.spec_id, source.revision, source.content_hash,
    source.prompt_snapshot_id, source.skill_bundle_hash, assessment.passed ? "歌词结构门禁通过" : "歌词结构需人工复核", JSON.stringify(assessment), Date.now(),
  );
  for (const dimension of assessment.dimensions) {
    await database.prepare(`
      INSERT INTO evaluation_dimensions (report_id, dimension_key, label, score, threshold, verdict, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(report_id, dimension_key) DO NOTHING
    `).run(reportId, dimension.key, dimension.label, dimension.score, dimension.threshold, dimension.verdict, JSON.stringify(dimension.evidence));
  }
  return reportId;
}

export async function saveSongEvaluation(
  database: HumDatabase,
  songId: string,
  assessment: CandidateAutoAssessment,
): Promise<string> {
  const song = await database.prepare("SELECT id, original_name, analysis_scene FROM songs WHERE id = ?").get(songId) as
    | { id: string; original_name: string; analysis_scene: SceneKey }
    | undefined;
  if (!song) throw new ApiError(404, "歌曲不存在，无法保存评分报告");
  const existing = await database.prepare(`
    SELECT id FROM evaluation_reports
    WHERE song_id = ? AND report_kind = 'acoustic' AND evaluator = 'hum-dsp' AND evaluator_version = ?
  `).get(songId, assessment.scores.analyzerVersion) as { id: string } | undefined;
  if (existing) return existing.id;

  const reportId = randomUUID();
  await database.prepare(`
    INSERT INTO evaluation_reports (
      id, subject_type, subject_id, candidate_id, song_id, report_kind, evaluator, evaluator_version,
      verdict, total_score, grade, domain, age_band, scene, provider, model,
      spec_id, spec_revision, spec_content_hash, prompt_snapshot_id, skill_bundle_hash,
      summary, raw_json, created_at
    ) VALUES (?, 'song', ?, NULL, ?, 'acoustic', 'hum-dsp', ?, ?, ?, ?, '', '', ?, '', '', NULL, NULL, '', NULL, '', ?, ?, ?)
  `).run(
    reportId,
    songId,
    songId,
    assessment.scores.analyzerVersion,
    assessment.passed ? "pass" : "fail",
    assessment.scores.total,
    assessment.scores.grade ?? "",
    song.analysis_scene,
    assessment.notes,
    JSON.stringify(assessment.scores),
    Date.now(),
  );
  await insertDimensions(database, reportId, assessment);
  return reportId;
}

let legacyBackfill: Promise<void> | null = null;

async function backfillLegacyCandidateReports(): Promise<void> {
  const database = getDb();
  const rows = await database.prepare(`
    SELECT r.candidate_id, r.verdict, r.notes, r.scores_json
    FROM candidate_reviews r
    LEFT JOIN evaluation_reports e
      ON e.candidate_id = r.candidate_id AND e.report_kind = 'acoustic' AND e.evaluator = 'hum-dsp'
    WHERE r.review_kind = 'auto' AND e.id IS NULL
    ORDER BY r.created_at
  `).all() as Array<{ candidate_id: string; verdict: string; notes: string; scores_json: string }>;
  for (const row of rows) {
    try {
      const scores = JSON.parse(row.scores_json) as CandidateAutoAssessment["scores"];
      await saveCandidateEvaluation(database, row.candidate_id, {
        passed: row.verdict === "pass",
        notes: row.notes,
        scores,
      });
    } catch {
      // 历史损坏行保留在 candidate_reviews，不伪造无法解析的结构化报告。
    }
  }
}

async function ensureLegacyReports(): Promise<void> {
  legacyBackfill ??= backfillLegacyCandidateReports().catch((error) => {
    legacyBackfill = null;
    throw error;
  });
  await legacyBackfill;
}

function mapReport(row: ReportRow): EvaluationReportSummary {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectTitle: row.subjectTitle,
    reportKind: row.reportKind,
    evaluator: row.evaluator,
    evaluatorVersion: row.evaluatorVersion,
    verdict: row.verdict,
    totalScore: row.totalScore,
    grade: row.grade,
    domain: row.domain,
    ageBand: row.ageBand,
    scene: row.scene,
    provider: row.provider,
    model: row.model,
    specId: row.specId,
    specRevision: row.specRevision,
    promptSnapshotId: row.promptSnapshotId,
    createdAt: row.createdAt,
  };
}

const REPORT_SELECT = `
  SELECT r.id, r.subject_type AS subjectType, r.subject_id AS subjectId,
         COALESCE(s.original_name, c.id) AS subjectTitle,
         r.report_kind AS reportKind, r.evaluator, r.evaluator_version AS evaluatorVersion,
         r.verdict, r.total_score AS totalScore, r.grade, r.domain, r.age_band AS ageBand,
         r.scene, r.provider, r.model, r.spec_id AS specId, r.spec_revision AS specRevision,
         r.prompt_snapshot_id AS promptSnapshotId, r.created_at AS createdAt,
         r.raw_json AS rawJson, r.summary, sp.content_json AS specContentJson,
         r.spec_content_hash AS specContentHash, ps.prompt, ps.lyrics, ps.request_json AS requestJson,
         ps.builder_version AS builderVersion, ps.tuning_id AS tuningId, r.skill_bundle_hash AS skillBundleHash
  FROM evaluation_reports r
  LEFT JOIN candidates c ON c.id = r.candidate_id
  LEFT JOIN songs s ON s.id = r.song_id
  LEFT JOIN song_specs sp ON sp.id = r.spec_id
  LEFT JOIN prompt_snapshots ps ON ps.id = r.prompt_snapshot_id
`;

export async function listEvaluationReports(filters: ReportFilters = {}) {
  await ensureLegacyReports();
  const database = getDb();
  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    clauses.push(clause);
    params.push(value);
  };
  if (filters.verdict) add("r.verdict = ?", filters.verdict);
  if (Number.isFinite(filters.minScore)) add("r.total_score >= ?", filters.minScore);
  if (Number.isFinite(filters.maxScore)) add("r.total_score <= ?", filters.maxScore);
  if (filters.domain) add("r.domain = ?", filters.domain);
  if (filters.ageBand) add("r.age_band = ?", filters.ageBand);
  if (filters.scene) add("r.scene = ?", filters.scene);
  if (filters.model) add("r.model = ?", filters.model);
  if (filters.dimension) {
    const dimensionClauses = ["d.report_id = r.id", "d.dimension_key = ?"];
    params.push(filters.dimension);
    if (Number.isFinite(filters.dimensionMax)) {
      dimensionClauses.push("d.score <= ?");
      params.push(filters.dimensionMax);
    }
    clauses.push(`EXISTS (SELECT 1 FROM evaluation_dimensions d WHERE ${dimensionClauses.join(" AND ")})`);
  }
  if (filters.search?.trim()) {
    clauses.push("(r.subject_id ILIKE ? OR COALESCE(s.original_name, '') ILIKE ? OR r.model ILIKE ? OR r.domain ILIKE ?)");
    const needle = `%${filters.search.trim()}%`;
    params.push(needle, needle, needle, needle);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await database.prepare(`SELECT COUNT(*) FROM evaluation_reports r LEFT JOIN songs s ON s.id = r.song_id ${where}`)
    .pluck().get(...params) as number;
  const page = Math.min(Math.max(filters.page ?? 1, 1), Math.max(1, Math.ceil(total / pageSize)));
  const rows = await database.prepare(`${REPORT_SELECT} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as ReportRow[];
  return {
    reports: rows.map(mapReport),
    total,
    page,
    pageSize,
  };
}

export async function getEvaluationReport(id: string) {
  await ensureLegacyReports();
  const database = getDb();
  const row = await database.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id) as ReportRow | undefined;
  if (!row) throw new ApiError(404, "评分报告不存在");
  const dimensions = await database.prepare(`
    SELECT dimension_key AS key, label, score, threshold, verdict, evidence_json AS evidenceJson
    FROM evaluation_dimensions WHERE report_id = ? ORDER BY score ASC NULLS LAST, dimension_key
  `).all(id) as Array<{ key: string; label: string; score: number | null; threshold: number | null; verdict: string; evidenceJson: string }>;
  const content = row.specContentJson ? JSON.parse(row.specContentJson) as {
    title?: string;
    learning?: { objective?: string };
    points?: Array<{ lead: string; answer: string; cue?: string }>;
  } : null;
  return {
    ...mapReport(row),
    summary: row.summary,
    raw: JSON.parse(row.rawJson),
    dimensions: dimensions.map((dimension) => ({
      ...dimension,
      evidence: JSON.parse(dimension.evidenceJson),
      evidenceJson: undefined,
    })),
    knowledge: content ? {
      title: content.title ?? "",
      objective: content.learning?.objective ?? "",
      points: content.points ?? [],
      contentHash: row.specContentHash,
    } : null,
    promptSnapshot: row.promptSnapshotId ? {
      id: row.promptSnapshotId,
      prompt: row.prompt ?? "",
      lyrics: row.lyrics ?? "",
      request: JSON.parse(row.requestJson || "{}"),
      builderVersion: row.builderVersion ?? "",
      tuning: row.tuningId ?? "general",
      skillBundleHash: row.skillBundleHash,
    } : null,
  };
}

export async function compareEvaluationReports(ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 20);
  if (unique.length < 2) throw new ApiError(400, "至少选择两份报告进行对比");
  return Promise.all(unique.map(getEvaluationReport));
}

export async function listTestSets(userId?: string) {
  const database = getDb();
  const where = userId ? "WHERE t.created_by = ?" : "";
  const params = userId ? [userId] : [];
  return database.prepare(`
    SELECT t.id, t.name, t.description, t.created_by AS createdBy, t.created_at AS createdAt,
           t.updated_at AS updatedAt, COUNT(i.report_id) AS itemCount
    FROM test_sets t LEFT JOIN test_set_items i ON i.test_set_id = t.id
    ${where}
    GROUP BY t.id ORDER BY t.updated_at DESC
  `).all(...params);
}

export async function createTestSet(name: string, description: string, userId: string) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new ApiError(400, "测试集名称需为 1–120 个字符");
  const id = randomUUID();
  const now = Date.now();
  await getDb().prepare(`
    INSERT INTO test_sets (id, name, description, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, trimmed, description.trim().slice(0, 1000), userId, now, now);
  return id;
}

export async function addReportsToTestSet(testSetId: string, reportIds: string[], userId: string): Promise<void> {
  const database = getDb();
  const exists = await database.prepare("SELECT 1 FROM test_sets WHERE id = ?").get(testSetId);
  if (!exists) throw new ApiError(404, "测试集不存在");
  await database.transaction(async (transaction) => {
    for (const reportId of [...new Set(reportIds)].slice(0, 100)) {
      await transaction.prepare(`
        INSERT INTO test_set_items (test_set_id, report_id, added_by, added_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(test_set_id, report_id) DO NOTHING
      `).run(testSetId, reportId, userId, Date.now());
    }
    await transaction.prepare("UPDATE test_sets SET updated_at = ? WHERE id = ?").run(Date.now(), testSetId);
  })();
}

export async function getTestSet(id: string) {
  const database = getDb();
  const testSet = await database.prepare(`
    SELECT id, name, description, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
    FROM test_sets WHERE id = ?
  `).get(id);
  if (!testSet) throw new ApiError(404, "测试集不存在");
  const reportIds = await database.prepare("SELECT report_id FROM test_set_items WHERE test_set_id = ? ORDER BY added_at")
    .pluck().all(id) as string[];
  return { ...testSet as object, reports: await Promise.all(reportIds.map(getEvaluationReport)) };
}

export async function removeReportFromTestSet(testSetId: string, reportId: string): Promise<void> {
  const result = await getDb().prepare("DELETE FROM test_set_items WHERE test_set_id = ? AND report_id = ?").run(testSetId, reportId);
  if (!result.changes) throw new ApiError(404, "测试集条目不存在");
}

export async function deleteTestSet(id: string, userId: string): Promise<void> {
  const result = await getDb().prepare("DELETE FROM test_sets WHERE id = ? AND created_by = ?").run(id, userId);
  if (!result.changes) throw new ApiError(404, "测试集不存在或无权删除");
}
