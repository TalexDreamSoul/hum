import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { getDb } from "./database";
import { stableJson } from "./song-specs";

const reviewInput = z.object({
  action: z.literal("review"),
  reviewKind: z.enum(["content", "music"]),
  verdict: z.enum(["pass", "fail", "needs_inpaint"]),
  notes: z.string().trim().max(2000).default(""),
  scores: z.record(z.string().max(80), z.union([z.number().finite(), z.string().max(240), z.boolean(), z.null()])).default({}),
}).strict();

export const candidateActionSchema = z.discriminatedUnion("action", [
  reviewInput,
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

async function candidateRecord(id: string) {
  const row = await getDb().prepare(`
    SELECT id, batch_id, spec_id, status, artifact_path, output_hash FROM candidates WHERE id = ?
  `).get(id) as CandidateRecord | undefined;
  if (!row) throw new ApiError(404, "候选不存在");
  return row;
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
  const candidate = await candidateRecord(id);
  const now = Date.now();

  if (parsed.action === "review") {
    if (candidate.status !== "generated") throw new ApiError(409, "只有通过自动质检的 generated 候选可以人工评审");
    const otherKind = parsed.reviewKind === "content" ? "music" : "content";
    const duplicateReviewer = await db.prepare(`
      SELECT 1 FROM candidate_reviews
      WHERE candidate_id = ? AND review_kind = ? AND reviewer_id = ? LIMIT 1
    `).get(id, otherKind, userId);
    if (duplicateReviewer) throw new ApiError(409, "内容评审与音乐评审必须由不同人员完成");
    const scoresJson = stableJson(parsed.scores);
    if (scoresJson.length > 10_000) throw new ApiError(400, "评审分数数据过大");
    await db.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO candidate_reviews (id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, parsed.reviewKind, parsed.verdict, scoresJson, parsed.notes, userId, now);
      if (parsed.verdict === "fail") {
        await transaction.prepare("UPDATE candidates SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?").run(parsed.notes || `${parsed.reviewKind} 评审未通过`, now, id);
      } else if (parsed.verdict === "needs_inpaint") {
        await transaction.prepare("UPDATE candidates SET status = 'needs_inpaint', error = ?, updated_at = ? WHERE id = ?").run(parsed.notes || "需要局部重绘", now, id);
      }
    })();
    return getCandidateDetail(id);
  }

  if (parsed.action === "reject" || parsed.action === "needs_inpaint") {
    if (!['generated', 'needs_inpaint'].includes(candidate.status)) throw new ApiError(409, "当前候选状态不能执行该操作");
    const status = parsed.action === "reject" ? "rejected" : "needs_inpaint";
    await db.prepare("UPDATE candidates SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, parsed.notes, now, id);
    return getCandidateDetail(id);
  }

  if (candidate.status !== "generated" || !candidate.artifact_path || !candidate.output_hash) {
    throw new ApiError(409, "只有已持久化且通过自动质检的 generated 候选可以批准为母带");
  }
  const latestReviews = await db.prepare(`
    SELECT review_kind, verdict, reviewer_id FROM candidate_reviews
    WHERE candidate_id = ? AND review_kind IN ('auto','content','music')
    ORDER BY created_at DESC
  `).all(id) as Array<{ review_kind: string; verdict: string; reviewer_id: string | null }>;
  const latest = new Map<string, { verdict: string; reviewerId: string | null }>();
  for (const review of latestReviews) {
    if (!latest.has(review.review_kind)) latest.set(review.review_kind, { verdict: review.verdict, reviewerId: review.reviewer_id });
  }
  if (["auto", "content", "music"].some((kind) => latest.get(kind)?.verdict !== "pass")) {
    throw new ApiError(409, "自动、内容和音乐评审必须全部通过");
  }
  if (latest.get("content")?.reviewerId === latest.get("music")?.reviewerId) {
    throw new ApiError(409, "内容评审与音乐评审必须由不同人员完成");
  }

  const masterId = randomUUID();
  await db.transaction(async (transaction) => {
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
