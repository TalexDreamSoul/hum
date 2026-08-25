import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./database";
import { requireCurrentCandidateHumanReviewRound } from "./governance";

export const candidateActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reject"), notes: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("needs_inpaint"), notes: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("approve_master") }).strict(),
]);

export interface CandidateReviewSummary {
  id: string;
  reviewKind: string;
  verdict: string;
  scores: unknown;
  notes: string;
  reviewerId: string | null;
  createdAt: number;
  reviewerName: string | null;
}

export interface ApprovedMasterSummary {
  id: string;
  masterHash: string;
  status: string;
  approvedBy: string;
  approvedAt: number;
}

export interface CandidateDetail {
  id: string;
  batchId: string;
  specId: string;
  provider: string;
  model: string;
  modelVersion: string;
  seed: number | null;
  status: string;
  inputHash: string;
  outputHash: string | null;
  latencyMs: number | null;
  costMicros: number | null;
  error: string;
  metadata: unknown;
  audioUrl: string | null;
  reviews: CandidateReviewSummary[];
  master: ApprovedMasterSummary | null;
  createdAt: number;
  updatedAt: number;
}

interface CandidateReviewRow extends Omit<CandidateReviewSummary, "scores"> {
  scoresJson: string;
}

interface CandidateRecord {
  id: string;
  batch_id: string;
  spec_id: string;
  status: string;
  artifact_path: string | null;
  output_hash: string | null;
}

interface CandidateDetailRow {
  id: string;
  batchId: string;
  specId: string;
  provider: string;
  model: string;
  modelVersion: string;
  seed: number | null;
  status: string;
  inputHash: string;
  outputHash: string | null;
  latencyMs: number | null;
  costMicros: number | null;
  error: string;
  metadataJson: string;
  createdAt: number;
  updatedAt: number;
}

export async function getCandidateDetail(id: string) {
  const db = getDb();
  const candidate = await db.prepare(`
    SELECT id, batch_id AS batchId, spec_id AS specId, provider, model, model_version AS modelVersion,
           seed, status, input_hash AS inputHash, output_hash AS outputHash, latency_ms AS latencyMs,
           cost_micros AS costMicros, error, metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt
    FROM candidates WHERE id = ?
  `).get(id) as CandidateDetailRow | undefined;
  if (!candidate) throw new ApiError(404, "候选不存在");
  const reviews = await db.prepare(`
    SELECT r.id, r.review_kind AS reviewKind, r.verdict, r.scores_json AS scoresJson, r.notes,
           r.reviewer_id AS reviewerId, u.display_name AS reviewerName, r.created_at AS createdAt
    FROM candidate_reviews r
    LEFT JOIN users u ON u.id = r.reviewer_id
    WHERE r.candidate_id = ? ORDER BY r.created_at
  `).all(id) as CandidateReviewRow[];
  const master = await db.prepare(`
    SELECT id, master_hash AS masterHash, status, approved_by AS approvedBy, approved_at AS approvedAt
    FROM approved_masters WHERE candidate_id = ?
  `).get(id) as ApprovedMasterSummary | undefined;
  const { metadataJson, ...summary } = candidate;
  return {
    ...summary,
    metadata: JSON.parse(metadataJson) as unknown,
    audioUrl: candidate.outputHash ? `/api/admin/candidates/${id}/audio` : null,
    reviews: reviews.map(({ scoresJson, ...review }) => ({
      ...review,
      scores: JSON.parse(scoresJson) as unknown,
    })),
    master: master ?? null,
  };
}

export async function actOnCandidate(id: string, input: unknown, userId: string) {
  const parsed = candidateActionSchema.parse(input);
  const db = getDb();
  const now = Date.now();

  if (parsed.action === "reject" || parsed.action === "needs_inpaint") {
    const status = parsed.action === "reject" ? "rejected" : "needs_inpaint";
    await db.transaction(async (transaction) => {
      const candidate = await transaction.prepare(`
        SELECT id, batch_id, spec_id, status, artifact_path, output_hash
        FROM candidates
        WHERE id = ?
        FOR UPDATE
      `).get<CandidateRecord>(id);
      if (!candidate) throw new ApiError(404, "候选不存在");
      if (!['generated', 'needs_inpaint'].includes(candidate.status)) throw new ApiError(409, "当前候选状态不能执行该操作");
      await transaction.prepare("UPDATE candidates SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, parsed.notes, now, id);
    })();
    return getCandidateDetail(id);
  }

  const masterId = randomUUID();
  await db.transaction(async (transaction) => {
    const candidate = await transaction.prepare(`
      SELECT id, batch_id, spec_id, status, artifact_path, output_hash
      FROM candidates
      WHERE id = ?
      FOR UPDATE
    `).get<CandidateRecord>(id);
    if (!candidate) throw new ApiError(404, "候选不存在");
    if (candidate.status !== "generated" || !candidate.artifact_path || !candidate.output_hash) {
      throw new ApiError(409, "只有已持久化且通过自动质检的 generated 候选可以批准为母带");
    }
    const auto = await transaction.prepare(`
      SELECT verdict
      FROM candidate_reviews
      WHERE candidate_id = ? AND review_kind = 'auto'
      ORDER BY created_at DESC
      LIMIT 1
    `).get<{ verdict: string }>(id);
    if (auto?.verdict !== "pass") {
      throw new ApiError(409, "自动评分只作为预筛，且必须通过后才可进入人工审批");
    }
    await requireCurrentCandidateHumanReviewRound(transaction, candidate.id);
    await transaction.prepare(`
      INSERT INTO approved_masters (
        id, spec_id, candidate_id, mixed_artifact_path, master_hash, approved_by, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(masterId, candidate.spec_id, id, candidate.artifact_path, candidate.output_hash, userId, now);
    await transaction.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?").run(now, id);
    await transaction.prepare("UPDATE experiment_batches SET status = 'completed', updated_at = ? WHERE id = ?").run(now, candidate.batch_id);
  })();
  return getCandidateDetail(id);
}
