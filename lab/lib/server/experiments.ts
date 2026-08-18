import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api";
import { masterAudioFile } from "./audio-master";
import { assessCandidateAudio } from "./candidate-analysis";
import { persistCandidateAudio } from "./candidates";
import type { SceneKey } from "../analysis/score";
import { getDb } from "./database";
import type { JobTracker } from "./jobs";
import { generateMiniMaxMusic, reserveMiniMaxRateLimit, type MiniMaxMusicRun } from "./minimax";
import { SCENES } from "../analysis/score";
import { getSongSpec, sha256, stableJson } from "./song-specs";
import { buildSongSpecLyrics, buildSongSpecPrompt } from "../song-spec";
import { MINIMAX_BATCH_MODELS, type MiniMaxBatchModel, type MiniMaxMusicModel } from "../minimax";
import { getProviderSettings } from "./settings";
import { saveCandidateEvaluation } from "./reports";
import { resolveSkills } from "./skills";
import { dispatchPendingNotifications, enqueueNotificationEvent, type NotificationEvent } from "./notifications";

export const createExperimentBatchSchema = z.object({
  specId: z.string().uuid(),
  models: z.array(z.enum(MINIMAX_BATCH_MODELS)).min(1).max(MINIMAX_BATCH_MODELS.length).optional(),
}).strict();

export interface CandidateSummary {
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
  /** 自动 ReportCard 的总分与等级，列表和趋势图直接用，不必逐个拉详情 */
  autoTotal: number | null;
  autoGrade: string | null;
  autoPassed: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExperimentBatchSummary {
  id: string;
  specId: string;
  status: string;
  variables: unknown;
  budgetLimitMicros: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  candidates: CandidateSummary[];
}

interface CandidateRow {
  auto_scores: string | null;
  auto_verdict: string | null;
  id: string;
  batch_id: string;
  spec_id: string;
  provider: string;
  model: string;
  model_version: string;
  seed: number | null;
  status: string;
  input_hash: string;
  output_hash: string | null;
  artifact_path: string | null;
  latency_ms: number | null;
  cost_micros: number | null;
  error: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

function autoScoreOf(row: CandidateRow): { total: number | null; grade: string | null; passed: boolean | null } {
  if (!row.auto_scores) return { total: null, grade: null, passed: null };
  try {
    const scores = JSON.parse(row.auto_scores) as { total?: number | null; grade?: string | null };
    return {
      total: typeof scores.total === "number" ? scores.total : null,
      grade: typeof scores.grade === "string" ? scores.grade : null,
      passed: row.auto_verdict === "pass",
    };
  } catch {
    return { total: null, grade: null, passed: row.auto_verdict === "pass" };
  }
}

function mapCandidate(row: CandidateRow): CandidateSummary {
  const auto = autoScoreOf(row);
  return {
    id: row.id,
    batchId: row.batch_id,
    specId: row.spec_id,
    provider: row.provider,
    model: row.model,
    modelVersion: row.model_version,
    seed: row.seed,
    status: row.status,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    latencyMs: row.latency_ms,
    costMicros: row.cost_micros,
    error: row.error,
    metadata: JSON.parse(row.metadata_json) as unknown,
    audioUrl: row.artifact_path ? `/api/admin/candidates/${row.id}/audio` : null,
    autoTotal: auto.total,
    autoGrade: auto.grade,
    autoPassed: auto.passed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listExperimentBatches() {
  const db = getDb();
  const batches = await db.prepare(`
    SELECT id, spec_id AS specId, status, variables_json AS variablesJson,
           budget_limit_micros AS budgetLimitMicros, created_by AS createdBy,
           created_at AS createdAt, updated_at AS updatedAt
    FROM experiment_batches ORDER BY created_at DESC LIMIT 50
  `).all() as Array<{
    id: string;
    specId: string;
    status: string;
    variablesJson: string;
    budgetLimitMicros: number | null;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
  }>;
  const candidatesQuery = db.prepare(`
    SELECT c.id, c.batch_id, c.spec_id, c.provider, c.model, c.model_version, c.seed, c.status,
           c.input_hash, c.output_hash, c.artifact_path, c.latency_ms, c.cost_micros,
           c.error, c.metadata_json, c.created_at, c.updated_at,
           (SELECT r.scores_json FROM candidate_reviews r
             WHERE r.candidate_id = c.id AND r.review_kind = 'auto'
             ORDER BY r.created_at DESC LIMIT 1) AS auto_scores,
           (SELECT r.verdict FROM candidate_reviews r
             WHERE r.candidate_id = c.id AND r.review_kind = 'auto'
             ORDER BY r.created_at DESC LIMIT 1) AS auto_verdict
    FROM candidates c WHERE c.batch_id = ? ORDER BY c.created_at
  `);
  return Promise.all(batches.map(async (batch) => ({
    id: batch.id,
    specId: batch.specId,
    status: batch.status,
    variables: JSON.parse(batch.variablesJson) as unknown,
    budgetLimitMicros: batch.budgetLimitMicros,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    candidates: ((await candidatesQuery.all(batch.id)) as CandidateRow[]).map(mapCandidate),
  })));
}

async function runCandidate(input: {
  candidateId: string;
  model: MiniMaxMusicModel;
  prompt: string;
  lyrics: string;
  scene: SceneKey;
  signal: AbortSignal;
  job?: JobTracker;
}): Promise<void> {
  const db = getDb();
  const started = Date.now();
  await db.prepare("UPDATE candidates SET status = 'generating', updated_at = ? WHERE id = ?").run(started, input.candidateId);
  input.job?.step(`MiniMax 开始生成：${input.model}`, { candidateId: input.candidateId });
  let run: MiniMaxMusicRun;
  try {
    run = await generateMiniMaxMusic({
      model: input.model,
      prompt: input.prompt,
      lyrics: input.lyrics,
      lyricsOptimizer: false,
      instrumental: false,
      outputFormat: "hex",
      signal: input.signal,
      onExchange: (exchange) => {
        input.job?.artifact("生成", "text", "发给 MiniMax 的请求体", {
          text: `POST ${exchange.endpoint}\n\n${JSON.stringify(exchange.requestBody, null, 2)}`,
        });
        input.job?.artifact("生成", "text", `MiniMax 返回摘要（HTTP ${exchange.status}）`, { text: exchange.responseText });
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MiniMax 生成启动失败";
    await db.prepare("UPDATE candidates SET status = 'failed', latency_ms = ?, error = ?, updated_at = ? WHERE id = ?").run(Date.now() - started, message.slice(0, 500), Date.now(), input.candidateId);
    input.job?.step("MiniMax 生成启动失败", message);
    return;
  }

  if (!run.ok || !run.audioBytes) {
    await db.prepare(`
      UPDATE candidates SET status = 'failed', latency_ms = ?, error = ?, metadata_json = ?, updated_at = ? WHERE id = ?
    `).run(run.latencyMs,
    run.error || "MiniMax 未返回候选音频",
    stableJson({ traceId: run.traceId ?? null }),
    Date.now(),
    input.candidateId,);
    input.job?.step("MiniMax 未返回候选音频", run.error);
    return;
  }

  try {
    input.job?.step(`音频已返回，耗时 ${(run.latencyMs / 1000).toFixed(1)} 秒，开始落盘与自动评分`, {
      sizeBytes: run.sizeBytes ?? run.audioBytes.byteLength,
      durationMs: run.durationMs ?? null,
    });
    const artifact = await persistCandidateAudio(input.candidateId, run.audioBytes);

    // 模型交出来的母带真峰值常年顶在 0 dBTP 以上，落盘后统一做响度归一与限峰，
    // 后面的自动评分测的就是我们真正要发的那份音频。
    const master = await masterAudioFile(artifact.absolutePath, SCENES[input.scene].lufsTarget, input.signal);
    input.job?.step(
      master.applied
        ? `响度归一：${master.before.lufs?.toFixed(1) ?? "?"} LUFS / ${master.before.truePeak?.toFixed(1) ?? "?"} dBTP → ${master.after.lufs?.toFixed(1) ?? "?"} LUFS / ${master.after.truePeak?.toFixed(1) ?? "?"} dBTP`
        : `响度归一未生效：${master.note}`,
      master.note,
    );
    input.job?.artifact("生成", "fields", "母带后处理", {
      fields: [
        { label: "处理", value: master.applied ? master.note : master.note },
        { label: "处理前", value: `${master.before.lufs?.toFixed(1) ?? "?"} LUFS · 真峰值 ${master.before.truePeak?.toFixed(1) ?? "?"} dBTP` },
        { label: "处理后", value: `${master.after.lufs?.toFixed(1) ?? "?"} LUFS · 真峰值 ${master.after.truePeak?.toFixed(1) ?? "?"} dBTP` },
        { label: "目标", value: `${master.targetLufs} LUFS · ${master.targetTruePeak} dBTP` },
      ],
    });

    const assessment = await assessCandidateAudio(artifact.absolutePath, input.scene, artifact.probe, input.signal, input.lyrics);
    const verdict = assessment.passed ? "pass" : "fail";
    const candidateStatus = assessment.passed ? "generated" : "rejected";
    const now = Date.now();
    const reportEvent: NotificationEvent = !assessment.passed
      ? "report.failed"
      : (assessment.scores.total ?? 0) >= 85 ? "report.high_score" : "report.completed";
    let reportId = "";
    await db.transaction(async (transaction) => {
      await transaction.prepare(`
        UPDATE candidates
        SET status = ?, output_hash = ?, artifact_path = ?, latency_ms = ?, cost_micros = ?, error = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `).run(candidateStatus,
      artifact.outputHash,
      artifact.relativePath,
      run.latencyMs,
      input.model.endsWith("-free") ? 0 : null,
      assessment.passed ? "" : assessment.notes.slice(0, 500),
      stableJson({
        master: master.applied ? { version: "hum-master-1", lufs: master.after.lufs, truePeak: master.after.truePeak } : null,
        traceId: run.traceId ?? null,
        durationMs: run.durationMs ?? null,
        sampleRate: run.sampleRate ?? null,
        channels: run.channels ?? null,
        bitrate: run.bitrate ?? null,
        sizeBytes: run.sizeBytes ?? run.audioBytes?.byteLength ?? null,
      }),
      now,
      input.candidateId,);
      await transaction.prepare(`
        INSERT INTO candidate_reviews (id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at)
        VALUES (?, ?, 'auto', ?, ?, ?, NULL, ?)
      `).run(randomUUID(), input.candidateId, verdict, stableJson(assessment.scores), assessment.notes, now);
      reportId = await saveCandidateEvaluation(transaction, input.candidateId, assessment);
      await enqueueNotificationEvent(transaction, `report:${reportId}:created`, reportEvent, {
        title: "候选评分报告已生成",
        status: assessment.passed ? ((assessment.scores.total ?? 0) >= 85 ? "高分" : "已完成") : "不合格",
        detail: assessment.notes,
        score: assessment.scores.total,
        grade: assessment.scores.grade,
        model: input.model,
        subjectId: input.candidateId,
        path: "/console/reports",
      });
    })();
    await dispatchPendingNotifications().catch(() => undefined);
    input.job?.step(
      `自动评分 ${assessment.scores.total ?? "—"}（${assessment.scores.grade ?? "—"}）→ ${assessment.passed ? "进入人工评审" : "自动淘汰"}`,
      assessment.notes,
    );
    input.job?.artifact("生成", "audio", "候选音频", {
      url: `/api/admin/candidates/${input.candidateId}/audio`,
      label: `${input.model} · ${(run.latencyMs / 1000).toFixed(1)} 秒`,
    });
    input.job?.artifact("评分", "scores", "自动 ReportCard", {
      total: assessment.scores.total,
      grade: assessment.scores.grade,
      threshold: assessment.scores.minimumPassScore,
      passed: assessment.passed,
      dims: assessment.scores.dims.map((dim) => ({ label: dim.label, score: dim.score, detail: dim.detail })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "候选音频持久化或自动评分失败";
    await db.prepare(`
      UPDATE candidates SET status = 'failed', latency_ms = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(Date.now() - started, message.slice(0, 500), Date.now(), input.candidateId);
    input.job?.step("候选落盘或自动评分失败", message);
  }
}

export async function createExperimentBatch(input: unknown, userId: string, signal: AbortSignal, job?: JobTracker) {
  const parsed = createExperimentBatchSchema.parse(input);
  const spec = await getSongSpec(parsed.specId);
  if (spec.status !== "approved") throw new ApiError(409, "只有 approved SongSpec 可以创建实验批次");
  const settings = await getProviderSettings();
  const models = [...new Set<MiniMaxBatchModel>(parsed.models?.length ? parsed.models : [settings.minimax.batchModel])];
  const normalizedAudience = spec.content.audience.replace(/[–—至到]/g, "-");
  const ageBand = ["3-4", "5-6", "7-8", "9-12"].find((value) => normalizedAudience.includes(value)) ?? "";
  const skills = await resolveSkills({ purpose: "generation", domain: spec.content.domain, ageBand, scene: spec.content.scene });

  await reserveMiniMaxRateLimit(userId, models);
  job?.step(`规格已确认：${spec.content.title} v${spec.revision}`, { specKey: spec.specKey, models });
  const prompt = buildSongSpecPrompt(spec.content);
  const lyrics = buildSongSpecLyrics(spec.content);
  const builderVersion = "hum-song-spec-prompt-2";
  const promptRequest = {
    provider: "minimax",
    scene: spec.content.scene,
    durationSec: spec.content.music.durationSec,
    bpm: spec.content.music.bpm,
    tuning: spec.content.music.tuning,
    requiredOutputs: spec.content.generation.requiredOutputs,
    skills: skills.skills.map((skill) => ({ name: skill.name, revision: skill.revision, contentHash: skill.contentHash })),
  };
  const promptSnapshotHash = sha256(stableJson({
    specContentHash: spec.contentHash,
    builderVersion,
    prompt,
    lyrics,
    request: promptRequest,
  }));
  job?.artifact("规格", "fields", "本次生成用的规格", {
    fields: [
      { label: "规格", value: `${spec.specKey} v${spec.revision}` },
      { label: "标题", value: spec.content.title },
      { label: "模型", value: models.join(" / ") },
      { label: "调优", value: spec.content.music.tuning.id },
      { label: "Skills", value: skills.skills.length ? skills.skills.map((skill) => `${skill.name} v${skill.revision}`).join("、") : "未绑定" },
      { label: "时长 / BPM", value: `${spec.content.music.durationSec} 秒 / ${spec.content.music.bpm}` },
      { label: "音域", value: `${spec.content.music.lowestNote}–${spec.content.music.highestNote}` },
      { label: "内容哈希", value: spec.contentHash },
      { label: "提示词快照", value: promptSnapshotHash },
    ],
  });
  job?.artifact("规格", "points", "知识点与句尾答案", {
    points: spec.content.points.map((point) => ({ lead: point.lead, answer: point.answer, cue: point.cue })),
  });
  job?.artifact("歌词", "text", "发给模型的歌词", { text: lyrics, language: spec.content.language });
  job?.artifact("提示词", "text", "发给模型的提示词", { text: prompt });
  const batchId = randomUUID();
  const proposedPromptSnapshotId = randomUUID();
  const now = Date.now();
  const candidates = models.map((model) => ({
    id: randomUUID(),
    model,
    inputHash: sha256(stableJson({ promptSnapshotHash, provider: "minimax", model })),
  }));

  const db = getDb();
  let promptSnapshotId: string = proposedPromptSnapshotId;
  await db.transaction(async (transaction) => {
    await transaction.prepare(`
      INSERT INTO prompt_snapshots (
        id, spec_id, tuning_id, system_prompt, prompt, lyrics, request_json, builder_version,
        skill_bundle_hash, content_hash, created_by, created_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO NOTHING
    `).run(
      proposedPromptSnapshotId,
      spec.id,
      spec.content.music.tuning.id,
      prompt,
      lyrics,
      stableJson(promptRequest),
      builderVersion,
      skills.bundleHash,
      promptSnapshotHash,
      userId,
      now,
    );
    const snapshot = await transaction.prepare("SELECT id FROM prompt_snapshots WHERE content_hash = ?").get(promptSnapshotHash) as { id: string } | undefined;
    if (!snapshot) throw new Error("提示词快照写入失败");
    promptSnapshotId = snapshot.id;
    for (const skill of skills.skills) {
      await transaction.prepare(`
        INSERT INTO run_skill_snapshots (id, job_id, prompt_snapshot_id, skill_revision_id, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(prompt_snapshot_id, skill_revision_id) DO NOTHING
      `).run(randomUUID(), job?.id ?? null, promptSnapshotId, skill.revisionId, skill.contentHash, now);
    }

    await transaction.prepare(`
      INSERT INTO experiment_batches (
        id, spec_id, status, variables_json, budget_limit_micros, created_by, created_at, updated_at, prompt_snapshot_id
      ) VALUES (?, ?, 'generating', ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      spec.id,
      stableJson({ provider: "minimax", models, specContentHash: spec.contentHash, promptSnapshotHash }),
      null,
      userId,
      now,
      now,
      promptSnapshotId,
    );
    const insertCandidate = transaction.prepare(`
      INSERT INTO candidates (
        id, batch_id, spec_id, provider, model, model_version, seed, status,
        input_hash, cost_micros, created_at, updated_at, prompt_snapshot_id
      ) VALUES (?, ?, ?, 'minimax', ?, 'provider-unversioned', NULL, 'pending', ?, ?, ?, ?, ?)
    `);
    for (const candidate of candidates) {
      await insertCandidate.run(
        candidate.id,
        batchId,
        spec.id,
        candidate.model,
        candidate.inputHash,
        candidate.model.endsWith("-free") ? 0 : null,
        now,
        now,
        promptSnapshotId,
      );
    }
  })();

  job?.step(`同提示词批次已建，${candidates.length} 个模型候选进入生成队列`, { batchId, promptSnapshotId });
  await Promise.all(candidates.map((candidate) => runCandidate({
    candidateId: candidate.id,
    model: candidate.model,
    prompt,
    lyrics,
    scene: spec.content.scene,
    signal,
    job,
  })));

  const successful = await db.prepare("SELECT COUNT(*) FROM candidates WHERE batch_id = ? AND status = 'generated'").pluck().get(batchId) as number;
  const batchStatus = successful > 0 ? "human_review" : "failed";
  await db.prepare("UPDATE experiment_batches SET status = ?, updated_at = ? WHERE id = ?").run(batchStatus, Date.now(), batchId);
  job?.step(`批次结束：${successful}/${candidates.length} 个候选可评审`);
  return (await listExperimentBatches()).find((batch) => batch.id === batchId);
}
