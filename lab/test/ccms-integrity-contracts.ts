/**
 * PostgreSQL CCMS integrity contracts.
 *
 * Requires an explicitly marked isolated database:
 *   HUM_POSTGRES_CONTRACT_TEST=1
 *   DATABASE_URL=postgresql://…/hum_ccms_contract_test
 *
 * The script creates one generated schema and drops only that schema during
 * cleanup. It never drops or truncates a database.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Client } from "pg";

const NEXT_EXTENSIONLESS_SUBPATHS = new Set([
  "next/server",
  "next/headers",
  "next/navigation",
]);

type PipelineProviderControl = {
  entered: () => void;
  release: Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

const PIPELINE_PROVIDER_CONTROL_KEY = "__humCcmsPipelineProviderControl";
const PIPELINE_MINIMAX_STUB_URL = `data:text/javascript,${encodeURIComponent([
  "export async function reserveMiniMaxRateLimit() {}",
  "export async function generateMiniMaxMusic() {",
  `  const control = globalThis[${JSON.stringify(PIPELINE_PROVIDER_CONTROL_KEY)}];`,
  "  if (control) { control.entered(); await control.release; }",
  "  return { ok: true, audioBytes: new Uint8Array([82, 73, 70, 70]), durationMs: 1, sampleRate: 44100, channels: 2, model: 'music-3.0-free' };",
  "}",
].join("\n"))}`;

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve: required(resolve, "deferred resolver") };
}

function setPipelineProviderControl(control: PipelineProviderControl | undefined) {
  const host = globalThis as typeof globalThis & { [PIPELINE_PROVIDER_CONTROL_KEY]?: PipelineProviderControl };
  if (control) host[PIPELINE_PROVIDER_CONTROL_KEY] = control;
  else delete host[PIPELINE_PROVIDER_CONTROL_KEY];
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20{}",
      };
    }

    if (specifier === "./minimax" && context.parentURL?.endsWith("/lib/server/pipelines.ts")) {
      return {
        shortCircuit: true,
        url: PIPELINE_MINIMAX_STUB_URL,
      };
    }

    if (NEXT_EXTENSIONLESS_SUBPATHS.has(specifier)) {
      try {
        return nextResolve(`${specifier}.js`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }

    if ((specifier.startsWith("./") || specifier.startsWith("../")) && extname(specifier) === "") {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

interface TestStatement {
  get<T>(...values: unknown[]): Promise<T | undefined>;
  all<T>(...values: unknown[]): Promise<T[]>;
  run(...values: unknown[]): Promise<unknown>;
}

interface TestDatabase {
  prepare(sql: string): TestStatement;
  exec(sql: string): Promise<void>;
}

type Failure = {
  threw: boolean;
  status: unknown;
  message: string;
};

type FixtureUsers = {
  admin: string;
  content: string;
  music: string;
  uploader: string;
};

const ISOLATED_DATABASE_NAME = /(?:^|[_-])(?:test|tests|contract)(?:[_-]|$)/i;
let failed = 0;

function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${got}`);
  if (!ok) failed++;
}

function targetDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("Refusing CCMS contract test: DATABASE_URL must explicitly name an isolated test database");
  if (process.env.HUM_POSTGRES_CONTRACT_TEST !== "1") {
    throw new Error("Refusing CCMS contract test: set HUM_POSTGRES_CONTRACT_TEST=1 for an isolated database");
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("Refusing CCMS contract test: DATABASE_URL is not a valid PostgreSQL URL");
  }

  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("Refusing CCMS contract test: DATABASE_URL must use postgres or postgresql");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, ""));
  if (!databaseName || databaseName.includes("/") || !ISOLATED_DATABASE_NAME.test(databaseName)) {
    throw new Error("Refusing CCMS contract test: DATABASE_URL database name must contain a test or contract marker");
  }
  return target;
}

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe generated PostgreSQL identifier");
  return `"${identifier}"`;
}

function scopedDatabaseUrl(target: URL, schema: string): string {
  const scoped = new URL(target.toString());
  const existingOptions = scoped.searchParams.get("options");
  scoped.searchParams.set("options", `${existingOptions ? `${existingOptions} ` : ""}-c search_path=${schema}`);
  return scoped.toString();
}

function restoreEnvironment(name: "DATABASE_URL" | "HUM_DATA_DIR", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function errorSummary(error: unknown): Omit<Failure, "threw"> {
  if (error instanceof Error) {
    return {
      status: "status" in error ? (error as Error & { status?: unknown }).status : undefined,
      message: error.message,
    };
  }
  return { status: undefined, message: String(error) };
}

async function captureFailure(action: () => Promise<unknown>): Promise<Failure> {
  try {
    await action();
    return { threw: false, status: undefined, message: "completed" };
  } catch (error) {
    return { threw: true, ...errorSummary(error) };
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function sessionActor(id: string, role: "admin" | "approver" | "uploader") {
  return { id, username: id, displayName: id, role };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clientContentHash(metadata: unknown): string | null {
  const integrity = asRecord(asRecord(metadata).integrity);
  const clientHashes = asRecord(integrity.clientHashes);
  return typeof clientHashes.contentHash === "string" ? clientHashes.contentHash : null;
}

function standardStages() {
  return [
    { key: "knowledge_expand", label: "知识扩写" },
    { key: "song_generate", label: "免费候选" },
    { key: "media_analyze", label: "媒体评分" },
    { key: "human_review", label: "人工复审" },
    { key: "notify", label: "进度通知" },
  ];
}

async function createFixtureUsers(database: TestDatabase, prefix: string): Promise<FixtureUsers> {
  const users: FixtureUsers = {
    admin: `${prefix}-admin`,
    content: `${prefix}-content`,
    music: `${prefix}-music`,
    uploader: `${prefix}-uploader`,
  };
  const now = Date.now();
  const records: Array<[string, string, string, "admin" | "approver" | "uploader"]> = [
    [users.admin, `${prefix}-admin`, "CCMS Contract Admin", "admin"],
    [users.content, `${prefix}-content`, "CCMS Contract Content", "approver"],
    [users.music, `${prefix}-music`, "CCMS Contract Music", "approver"],
    [users.uploader, `${prefix}-uploader`, "CCMS Contract Uploader", "uploader"],
  ];
  for (const [id, username, displayName, role] of records) {
    await database.prepare(`
      INSERT INTO users (id, username, display_name, password_salt, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 'contract-salt', 'contract-hash', ?, 'active', ?, ?)
    `).run(id, username, displayName, role, now, now);
  }
  return users;
}

async function createApprovedSpec(database: TestDatabase, prefix: string, adminId: string): Promise<string> {
  const sourceId = `${prefix}-source`;
  const specId = `${prefix}-spec`;
  const now = Date.now();
  await database.prepare(`
    INSERT INTO source_materials (id, source_type, title, source_version, license, source_hash, content_json, created_by, created_at)
    VALUES (?, 'original', 'CCMS contract source', '1', 'test-only', ?, '{}', ?, ?)
  `).run(sourceId, `${prefix}-source-hash`, adminId, now);
  await database.prepare(`
    INSERT INTO song_specs (
      id, spec_key, revision, parent_id, source_material_id, status, content_json, content_hash,
      created_by, approved_by, approved_at, created_at
    ) VALUES (?, ?, 1, NULL, ?, 'approved', '{}', ?, ?, ?, ?, ?)
  `).run(specId, `${prefix}-song`, sourceId, `${prefix}-spec-hash`, adminId, adminId, now, now);
  return specId;
}

async function createGeneratedCandidate(
  database: TestDatabase,
  prefix: string,
  specId: string,
  adminId: string,
  label: string,
): Promise<string> {
  const id = randomUUID().replaceAll("-", "");
  const batchId = `${prefix}-batch-${label}-${id}`;
  const candidateId = `${prefix}-candidate-${label}-${id}`;
  const now = Date.now();
  await database.prepare(`
    INSERT INTO experiment_batches (id, spec_id, status, variables_json, budget_limit_micros, created_by, created_at, updated_at)
    VALUES (?, ?, 'human_review', '{}', NULL, ?, ?, ?)
  `).run(batchId, specId, adminId, now, now);
  await database.prepare(`
    INSERT INTO candidates (
      id, batch_id, spec_id, provider, model, model_version, seed, status, input_hash, output_hash,
      artifact_path, latency_ms, cost_micros, error, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'mock', 'music-3.0-free', 'contract-v1', 1, 'generated', ?, ?, ?, 1, 0, '', '{}', ?, ?)
  `).run(
    candidateId,
    batchId,
    specId,
    `${prefix}-input-${label}-${id}`,
    `${prefix}-output-${label}-${id}`,
    `mock/candidates/${candidateId}.wav`,
    now,
    now,
  );
  await database.prepare(`
    INSERT INTO candidate_reviews (
      id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at,
      round_no, rubric_revision_id, assignment_id, decision_reason
    ) VALUES (?, ?, 'auto', 'pass', '{"total":90}', 'automatic pre-screen pass', NULL, ?, 1, NULL, NULL, '')
  `).run(`${prefix}-auto-${label}-${id}`, candidateId, now);
  return candidateId;
}

async function createPassedRound(database: TestDatabase, candidateId: string, roundNo: number, adminId: string): Promise<string> {
  const id = `${candidateId}-round-${roundNo}`;
  const now = Date.now();
  await database.prepare(`
    INSERT INTO review_rounds (id, candidate_id, round_no, status, opened_by, closed_by, created_at, closed_at)
    VALUES (?, ?, ?, 'passed', ?, ?, ?, ?)
  `).run(id, candidateId, roundNo, adminId, adminId, now, now);
  return id;
}

async function addAssignedPass(
  database: TestDatabase,
  roundId: string,
  candidateId: string,
  roundNo: number,
  reviewKind: "content" | "music",
  reviewerId: string,
  adminId: string,
  label: string,
): Promise<void> {
  const assignmentId = `${roundId}-${reviewKind}-${label}-assignment`;
  const reviewId = `${roundId}-${reviewKind}-${label}-review`;
  const now = Date.now();
  await database.prepare(`
    INSERT INTO review_assignments (
      id, review_round_id, review_kind, reviewer_id, status, assigned_by, created_at, submitted_at
    ) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?)
  `).run(assignmentId, roundId, reviewKind, reviewerId, adminId, now, now);
  await database.prepare(`
    INSERT INTO candidate_reviews (
      id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at,
      round_no, rubric_revision_id, assignment_id, decision_reason
    ) VALUES (?, ?, ?, 'pass', '{"total":90}', 'assigned human pass', ?, ?, ?, NULL, ?, 'assigned human pass')
  `).run(reviewId, candidateId, reviewKind, reviewerId, now + 1, roundNo, assignmentId);
}

async function addUnassignedPass(
  database: TestDatabase,
  candidateId: string,
  roundNo: number,
  reviewKind: "content" | "music",
  reviewerId: string,
  label: string,
): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO candidate_reviews (
      id, candidate_id, review_kind, verdict, scores_json, notes, reviewer_id, created_at,
      round_no, rubric_revision_id, assignment_id, decision_reason
    ) VALUES (?, ?, ?, 'pass', '{"total":90}', 'legacy unassigned pass', ?, ?, ?, NULL, NULL, 'legacy unassigned pass')
  `).run(`${candidateId}-${reviewKind}-${label}-legacy`, candidateId, reviewKind, reviewerId, now, roundNo);
}

async function candidateState(database: TestDatabase, candidateId: string): Promise<{ status: string | null; masterCount: number; masterStatus: string | null }> {
  const candidate = await database.prepare("SELECT status FROM candidates WHERE id = ?").get<{ status: string }>(candidateId);
  const master = await database.prepare("SELECT status FROM approved_masters WHERE candidate_id = ?").get<{ status: string }>(candidateId);
  return { status: candidate?.status ?? null, masterCount: master ? 1 : 0, masterStatus: master?.status ?? null };
}

async function createUploadGrant(
  database: TestDatabase,
  key: string,
  userId: string,
  originalName: string,
  sizeBytes: number,
): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO upload_grants (object_key, user_id, original_name, mime_type, size_bytes, expires_at, created_at)
    VALUES (?, ?, ?, 'audio/wav', ?, ?, ?)
  `).run(key, userId, originalName, sizeBytes, now + 60_000, now);
}

async function main() {
  const target = targetDatabaseUrl();
  const schema = `hum_ccms_integrity_contract_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quotedIdentifier(schema);
  const prefix = `ccms-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDataDir = process.env.HUM_DATA_DIR;
  const control = new Client({ connectionString: target.toString() });
  let controlConnected = false;
  let schemaCreated = false;
  let dataDir: string | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  let workError: unknown;

  try {
    await control.connect();
    controlConnected = true;
    await control.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await control.query(`SET search_path TO ${quotedSchema}`);

    dataDir = await mkdtemp(join(tmpdir(), "hum-ccms-integrity-contract-"));
    process.env.HUM_DATA_DIR = dataDir;
    process.env.DATABASE_URL = scopedDatabaseUrl(target, schema);

    const [
      { closeDatabase: close, getDb, waitForDatabase },
      { controlPipelinePlan, createPipelinePlan, createPipelineTemplate, executePipelinePlan, getPipelinePlan, listRunnablePipelinePlanIds },
      { actOnCandidate },
      { actOnGovernance },
      { executeKnowledgeAction },
      { executeCatalogMutation },
      {
        beginSongMediaAnalysis,
        extractMediaTechnicalMetadata,
        getMediaAsset,
        markSongMediaAnalysisFailed,
        registerMockMediaAsset,
        registerUploadedSongMedia,
        syncSongMediaAnalysis,
      },
    ] = await Promise.all([
      import("../lib/server/database.ts"),
      import("../lib/server/pipelines.ts"),
      import("../lib/server/candidate-review.ts"),
      import("../lib/server/governance.ts"),
      import("../lib/server/knowledge.ts"),
      import("../lib/server/catalog.ts"),
      import("../lib/server/media.ts"),
    ]);
    closeDatabase = close;
    await waitForDatabase();
    const database = getDb() as unknown as TestDatabase;

    const activeSchema = await database.prepare("SELECT current_schema() AS schema").get<{ schema: string }>();
    if (activeSchema?.schema !== schema) throw new Error("CCMS contract test did not receive its generated PostgreSQL schema");

    const users = await createFixtureUsers(database, prefix);
    const specId = await createApprovedSpec(database, prefix, users.admin);

    const adminActor = sessionActor(users.admin, "admin");
    const contentActor = sessionActor(users.content, "approver");
    const musicActor = sessionActor(users.music, "approver");
    const uploaderActor = sessionActor(users.uploader, "uploader");

    const knowledgeDomain = asRecord(await executeKnowledgeAction("domains", "create", {
      slug: `${prefix}-knowledge`,
      name: "CCMS uploader revision contract",
      description: "Isolated ownership fixture",
    }, users.admin, "admin"));
    const knowledgeDomainId = requiredString(asRecord(knowledgeDomain.domain).id, "knowledge domain id");
    const ownKnowledge = asRecord(await executeKnowledgeAction("items", "create", {
      domainId: knowledgeDomainId,
      slug: `${prefix}-uploader-draft`,
      title: "Uploader-owned draft",
      objective: "Verify owner-scoped draft revisions.",
      lead: "Who may revise this draft?",
      answer: "Its uploader owner may revise it while it remains draft.",
      summary: "Owner-scoped revision fixture.",
      ageBand: "4-6",
      contentRisk: "low",
      sourceLocator: "contract:own-draft",
    }, users.uploader, "uploader"));
    const ownKnowledgeId = requiredString(asRecord(ownKnowledge.item).id, "uploader-owned knowledge id");
    const ownRevision = asRecord(await executeKnowledgeAction("items", "revise", {
      id: ownKnowledgeId,
      title: "Uploader-owned draft revised",
      objective: "Verify the uploader can create a new immutable revision while draft.",
      lead: "Who may revise this draft?",
      answer: "Only its uploader owner may revise the draft.",
      summary: "Owner-scoped revision fixture after revision.",
      ageBand: "4-6",
      contentRisk: "low",
      sourceLocator: "contract:own-draft-r2",
    }, users.uploader, "uploader"));
    const ownKnowledgeState = await database.prepare(`
      SELECT status, current_revision, updated_by FROM knowledge_items WHERE id = ?
    `).get<{ status: string; current_revision: number; updated_by: string }>(ownKnowledgeId);
    const ownKnowledgeRevisionCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM knowledge_item_revisions WHERE item_id = ?
    `).get<{ count: number }>(ownKnowledgeId);
    check(
      "An uploader can revise its own draft knowledge into a new immutable draft revision",
      asRecord(ownRevision.item).status === "draft"
        && Number(asRecord(ownRevision.item).currentRevision) === 2
        && ownKnowledgeState?.status === "draft"
        && ownKnowledgeState.current_revision === 2
        && ownKnowledgeState.updated_by === users.uploader
        && ownKnowledgeRevisionCount?.count === 2,
      JSON.stringify({ result: ownRevision, state: ownKnowledgeState, revisionCount: ownKnowledgeRevisionCount?.count ?? null }),
    );

    const otherKnowledge = asRecord(await executeKnowledgeAction("items", "create", {
      domainId: knowledgeDomainId,
      slug: `${prefix}-admin-draft`,
      title: "Admin-owned draft",
      objective: "Verify another user cannot revise this draft.",
      lead: "Who owns this draft?",
      answer: "The administrator owns it.",
      summary: "Other-owner revision fixture.",
      ageBand: "4-6",
      contentRisk: "low",
      sourceLocator: "contract:other-draft",
    }, users.admin, "admin"));
    const otherKnowledgeId = requiredString(asRecord(otherKnowledge.item).id, "other-owner knowledge id");
    const otherKnowledgeBefore = required(await database.prepare(`
      SELECT status, current_revision, updated_by FROM knowledge_items WHERE id = ?
    `).get<{ status: string; current_revision: number; updated_by: string }>(otherKnowledgeId), "other-owner knowledge before state");
    const otherKnowledgeFailure = await captureFailure(() => executeKnowledgeAction("items", "revise", {
      id: otherKnowledgeId,
      title: "Unauthorized other-owner revision",
      objective: "This revision must be denied.",
      lead: "Who attempted the revision?",
      answer: "An unrelated uploader.",
      summary: "Unauthorized mutation.",
      ageBand: "4-6",
      contentRisk: "low",
      sourceLocator: "contract:other-owner-denied",
    }, users.uploader, "uploader"));
    const otherKnowledgeAfter = await database.prepare(`
      SELECT status, current_revision, updated_by FROM knowledge_items WHERE id = ?
    `).get<{ status: string; current_revision: number; updated_by: string }>(otherKnowledgeId);

    const otherKnowledgeSubmitFailure = await captureFailure(() => executeKnowledgeAction(
      "items",
      "submit",
      { id: otherKnowledgeId },
      users.uploader,
      "uploader",
    ));
    const publishedSeed = required(await database.prepare(`
      SELECT i.id, i.status, i.current_revision, r.objective, r.lead, r.answer, r.summary, r.age_band, r.content_risk, r.source_revision_id, r.source_locator, r.content_hash
      FROM knowledge_items i
      JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
      WHERE i.status = 'published' AND i.id LIKE 'seed-%'
      ORDER BY i.id ASC
      LIMIT 1
    `).get<{
      id: string;
      status: string;
      current_revision: number;
      objective: string;
      lead: string;
      answer: string;
      summary: string;
      age_band: string;
      content_risk: "low" | "medium" | "high";
      source_revision_id: string | null;
      source_locator: string;
      content_hash: string;
    }>(), "published seed knowledge");
    const publishedSeedFailure = await captureFailure(() => executeKnowledgeAction("items", "revise", {
      id: publishedSeed.id,
      title: `${prefix} protected seed revision`,
      objective: publishedSeed.objective,
      lead: publishedSeed.lead,
      answer: publishedSeed.answer,
      summary: publishedSeed.summary,
      ageBand: publishedSeed.age_band,
      contentRisk: publishedSeed.content_risk,
      ...(publishedSeed.source_revision_id ? { sourceRevisionId: publishedSeed.source_revision_id } : {}),
      sourceLocator: publishedSeed.source_locator,
    }, users.uploader, "uploader"));
    const publishedSeedAfter = await database.prepare(`
      SELECT status, current_revision, content_hash
      FROM knowledge_items i
      JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
      WHERE i.id = ?
    `).get<{ status: string; current_revision: number; content_hash: string }>(publishedSeed.id);
    check(
      "An uploader cannot revise or submit another owner’s draft knowledge, or revise a published seed knowledge item",
      otherKnowledgeFailure.threw
        && otherKnowledgeSubmitFailure.threw
        && otherKnowledgeAfter?.status === otherKnowledgeBefore.status
        && otherKnowledgeAfter.current_revision === otherKnowledgeBefore.current_revision
        && otherKnowledgeAfter.updated_by === otherKnowledgeBefore.updated_by
        && publishedSeedFailure.threw
        && publishedSeedAfter?.status === publishedSeed.status
        && publishedSeedAfter.current_revision === publishedSeed.current_revision
        && publishedSeedAfter.content_hash === publishedSeed.content_hash,
      JSON.stringify({ otherOwner: { reviseFailure: otherKnowledgeFailure, submitFailure: otherKnowledgeSubmitFailure, before: otherKnowledgeBefore, after: otherKnowledgeAfter }, publishedSeed: { failure: publishedSeedFailure, before: publishedSeed, after: publishedSeedAfter } }),
    );

    const uploaderTargetCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "uploader-target");
    const uploaderTargetRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: uploaderTargetCandidate },
    }, adminActor)).id, "uploader target round id");
    const uploaderTargetFailure = await captureFailure(() => actOnGovernance({
      resource: "rounds",
      action: "assign",
      payload: { roundId: uploaderTargetRound, contentReviewerId: users.uploader, musicReviewerId: users.content },
    }, adminActor));
    const uploaderTargetAssignments = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM review_assignments WHERE review_round_id = ?
    `).get<{ count: number }>(uploaderTargetRound);

    const uploaderAssignmentActorCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "uploader-assign-actor");
    const uploaderAssignmentActorRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: uploaderAssignmentActorCandidate },
    }, adminActor)).id, "uploader assignment actor round id");
    const uploaderAssignmentActorFailure = await captureFailure(() => actOnGovernance({
      resource: "rounds",
      action: "assign",
      payload: { roundId: uploaderAssignmentActorRound, contentReviewerId: users.admin, musicReviewerId: users.content },
    }, uploaderActor));
    const uploaderActorAssignments = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM review_assignments WHERE review_round_id = ?
    `).get<{ count: number }>(uploaderAssignmentActorRound);

    const legalRoundCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "legal-reviewers");
    const legalRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: legalRoundCandidate },
    }, adminActor)).id, "legal review round id");
    const adminAssignment = asRecord(await actOnGovernance({
      resource: "rounds",
      action: "assign",
      payload: { roundId: legalRound, contentReviewerId: users.admin, musicReviewerId: users.content },
    }, adminActor));
    const adminSubmission = asRecord(await actOnGovernance({
      resource: "rounds",
      action: "submit",
      payload: { roundId: legalRound, reviewKind: "content", verdict: "pass", scores: { total: 91 }, notes: "admin content pass" },
    }, adminActor));
    const approverSubmission = asRecord(await actOnGovernance({
      resource: "rounds",
      action: "submit",
      payload: { roundId: legalRound, reviewKind: "music", verdict: "pass", scores: { total: 92 }, notes: "approver music pass" },
    }, contentActor));
    const legalSubmissionCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM review_assignments WHERE review_round_id = ? AND status = 'submitted'
    `).get<{ count: number }>(legalRound);
    const legalReviewCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM candidate_reviews WHERE candidate_id = ? AND assignment_id IS NOT NULL
    `).get<{ count: number }>(legalRoundCandidate);

    const approverAssignmentCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "approver-assigns");
    const approverAssignmentRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: approverAssignmentCandidate },
    }, adminActor)).id, "approver assignment round id");
    const approverAssignment = asRecord(await actOnGovernance({
      resource: "rounds",
      action: "assign",
      payload: { roundId: approverAssignmentRound, contentReviewerId: users.admin, musicReviewerId: users.music },
    }, musicActor));
    const approverAssignedCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM review_assignments WHERE review_round_id = ? AND status = 'assigned'
    `).get<{ count: number }>(approverAssignmentRound);

    const forgedAssignmentCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "forged-uploader-assignment");
    const forgedAssignmentRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: forgedAssignmentCandidate },
    }, adminActor)).id, "forged uploader assignment round id");
    const forgedAssignmentId = `${prefix}-forged-uploader-assignment`;
    const forgedAssignmentNow = Date.now();
    await database.prepare(`
      INSERT INTO review_assignments (id, review_round_id, review_kind, reviewer_id, status, assigned_by, created_at)
      VALUES (?, ?, 'content', ?, 'assigned', ?, ?)
    `).run(forgedAssignmentId, forgedAssignmentRound, users.uploader, users.admin, forgedAssignmentNow);
    const forgedUploaderSubmission = await captureFailure(() => actOnGovernance({
      resource: "rounds",
      action: "submit",
      payload: { roundId: forgedAssignmentRound, reviewKind: "content", verdict: "pass", scores: { total: 93 }, notes: "forged uploader submission" },
    }, uploaderActor));
    const forgedAssignmentState = await database.prepare(`
      SELECT status, submitted_at FROM review_assignments WHERE id = ?
    `).get<{ status: string; submitted_at: number | null }>(forgedAssignmentId);
    const forgedReviewCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM candidate_reviews WHERE candidate_id = ? AND assignment_id = ?
    `).get<{ count: number }>(forgedAssignmentCandidate, forgedAssignmentId);
    check(
      "Uploader review assignment and forged submission are rejected while admin and approver assignments and submissions remain legal",
      uploaderTargetFailure.threw
        && uploaderTargetAssignments?.count === 0
        && uploaderAssignmentActorFailure.threw
        && uploaderActorAssignments?.count === 0
        && adminAssignment.ok === true
        && adminSubmission.ok === true
        && approverSubmission.ok === true
        && legalSubmissionCount?.count === 2
        && legalReviewCount?.count === 2
        && approverAssignment.ok === true
        && approverAssignedCount?.count === 2
        && forgedUploaderSubmission.threw
        && forgedAssignmentState?.status === "assigned"
        && forgedAssignmentState.submitted_at === null
        && forgedReviewCount?.count === 0,
      JSON.stringify({
        uploaderTarget: { failure: uploaderTargetFailure, assignments: uploaderTargetAssignments?.count ?? null },
        uploaderActor: { failure: uploaderAssignmentActorFailure, assignments: uploaderActorAssignments?.count ?? null },
        legal: { adminAssignment, adminSubmission, approverSubmission, submissions: legalSubmissionCount?.count ?? null, reviews: legalReviewCount?.count ?? null },
        approverAssignment: { result: approverAssignment, assignments: approverAssignedCount?.count ?? null },
        forgedSubmission: { failure: forgedUploaderSubmission, assignment: forgedAssignmentState, reviews: forgedReviewCount?.count ?? null },
      }),
    );

    const missingHumanKey = `${prefix}-missing-human`;
    const reorderedKey = `${prefix}-reordered-human`;
    const missingHuman = await captureFailure(() => createPipelineTemplate({
      templateKey: missingHumanKey,
      name: "Missing human review",
      stages: standardStages().filter((stage) => stage.key !== "human_review"),
    }, users.admin));
    const reordered = standardStages();
    [reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
    const reorderedHuman = await captureFailure(() => createPipelineTemplate({
      templateKey: reorderedKey,
      name: "Reordered human review",
      stages: reordered,
    }, users.admin));
    const rejectedTemplateCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM pipeline_templates WHERE template_key IN (?, ?)
    `).get<{ count: number }>(missingHumanKey, reorderedKey);
    check(
      "Pipeline templates reject both a missing human_review stage and a reordered stage sequence",
      missingHuman.threw && reorderedHuman.threw && rejectedTemplateCount?.count === 0,
      JSON.stringify({ missingHuman, reorderedHuman, rows: rejectedTemplateCount?.count ?? null }),
    );

    const templateKey = `${prefix}-legal-pipeline`;
    const template = await createPipelineTemplate({
      templateKey,
      name: "CCMS legal pipeline",
      description: "Isolated contract fixture",
      stages: standardStages(),
    }, users.admin);
    const revision = required(await database.prepare(`
      SELECT id FROM pipeline_template_revisions WHERE template_id = ? AND revision = 1
    `).get<{ id: string }>(template.id), "legal pipeline revision");
    const normalAuditCount = await database.prepare(`
      SELECT COUNT(*)::int AS count
      FROM audit_log
      WHERE action = 'pipeline_template.create' AND target_type = 'pipeline_template' AND target_id = ?
    `).get<{ count: number }>(template.id);
    check(
      "A successful template mutation writes exactly one scoped audit record",
      normalAuditCount?.count === 1,
      JSON.stringify(normalAuditCount ?? null),
    );

    const plan = await createPipelinePlan({
      templateRevisionId: revision.id,
      name: "CCMS automatic stage contract",
      input: { theme: "水循环" },
      start: true,
    }, users.admin);
    const automaticExecution = await captureFailure(() => executePipelinePlan(plan.id, `${prefix}-automatic-worker`));
    const waitingPlan = await getPipelinePlan(plan.id);
    const reviewStage = waitingPlan.stages.find((stage) => stage.stageKey === "human_review");
    const stageSnapshot = waitingPlan.stages.map((stage) => ({ key: stage.stageKey, status: stage.status }));
    check(
      "A legal pipeline executes only automatic stages and pauses at the human-review boundary",
      !automaticExecution.threw
        && waitingPlan.status === "awaiting_review"
        && JSON.stringify(stageSnapshot) === JSON.stringify([
          { key: "knowledge_expand", status: "succeeded" },
          { key: "song_generate", status: "succeeded" },
          { key: "media_analyze", status: "succeeded" },
          { key: "human_review", status: "paused" },
          { key: "notify", status: "queued" },
        ])
        && reviewStage?.checkpoint.manualApprovalRequired === true,
      JSON.stringify({ execution: automaticExecution, status: waitingPlan.status, stages: stageSnapshot, checkpoint: reviewStage?.checkpoint }),
    );

    const delayedProviderEntered = deferred<void>();
    const delayedProviderRelease = deferred<void>();
    let delayedExecution: Promise<void> | undefined;
    let delayedPlanId = "";
    setPipelineProviderControl({
      entered: () => delayedProviderEntered.resolve(undefined),
      release: delayedProviderRelease.promise,
    });
    try {
      const delayedPlan = await createPipelinePlan({
        templateRevisionId: revision.id,
        name: "CCMS cancellation race contract",
        input: { theme: "延迟取消" },
        start: true,
      }, users.admin);
      delayedPlanId = delayedPlan.id;
      delayedExecution = executePipelinePlan(delayedPlan.id, `${prefix}-late-provider-worker`);
      await delayedProviderEntered.promise;
      const runningDelayedPlan = await getPipelinePlan(delayedPlan.id);
      const cancellingPlan = await controlPipelinePlan(delayedPlan.id, { action: "cancel", reason: "cancel while provider is delayed" }, users.admin);
      await executePipelinePlan(delayedPlan.id, `${prefix}-cancellation-finalizer`);
      const cancelledBeforeProviderRelease = await getPipelinePlan(delayedPlan.id);
      delayedProviderRelease.resolve(undefined);
      await delayedExecution;
      const cancelledAfterProviderRelease = await getPipelinePlan(delayedPlan.id);
      const delayedSong = cancelledAfterProviderRelease.stages.find((stage) => stage.stageKey === "song_generate");
      const delayedMedia = cancelledAfterProviderRelease.stages.find((stage) => stage.stageKey === "media_analyze");
      const delayedNotify = cancelledAfterProviderRelease.stages.find((stage) => stage.stageKey === "notify");
      const laterStageStarted = cancelledAfterProviderRelease.events.some((event) =>
        event.eventType === "stage.running" && event.payload.stageKey === "media_analyze",
      );
      const laterStageSucceeded = cancelledAfterProviderRelease.events.some((event) =>
        event.eventType === "stage.succeeded" && event.payload.stageKey === "media_analyze",
      );
      check(
        "Cancelling a delayed provider stage keeps the plan and late stage cancelled and never starts the next stage",
        runningDelayedPlan.status === "running"
          && runningDelayedPlan.stages.find((stage) => stage.stageKey === "song_generate")?.status === "running"
          && cancellingPlan.status === "cancelling"
          && cancelledBeforeProviderRelease.status === "cancelled"
          && cancelledAfterProviderRelease.status === "cancelled"
          && delayedSong?.status === "cancelled"
          && delayedMedia?.status === "cancelled"
          && delayedNotify?.status === "cancelled"
          && !laterStageStarted
          && !laterStageSucceeded,
        JSON.stringify({
          planId: delayedPlanId,
          running: runningDelayedPlan.stages.map((stage) => ({ key: stage.stageKey, status: stage.status })),
          beforeRelease: { status: cancelledBeforeProviderRelease.status, stages: cancelledBeforeProviderRelease.stages.map((stage) => ({ key: stage.stageKey, status: stage.status })) },
          afterRelease: { status: cancelledAfterProviderRelease.status, stages: cancelledAfterProviderRelease.stages.map((stage) => ({ key: stage.stageKey, status: stage.status })), events: cancelledAfterProviderRelease.events.map((event) => ({ type: event.eventType, stage: event.payload.stageKey ?? null })) },
        }),
      );
    } finally {
      delayedProviderRelease.resolve(undefined);
      setPipelineProviderControl(undefined);
      if (delayedExecution) await delayedExecution.catch(() => undefined);
    }
    const expiredPlan = await createPipelinePlan({
      templateRevisionId: revision.id,
      name: "CCMS expired lease recovery contract",
      input: { theme: "过期租约回收" },
    }, users.admin);
    const expiredAt = Date.now() - 5_000;
    await database.prepare(`
      UPDATE pipeline_plans
      SET status = 'running', lease_owner = 'dead-worker', lease_expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(expiredAt, expiredAt, expiredPlan.id);
    const runnableAfterLeaseExpiry = await listRunnablePipelinePlanIds(100);
    await executePipelinePlan(expiredPlan.id, `${prefix}-recovery-worker`);
    const recoveredPlan = await getPipelinePlan(expiredPlan.id);
    check(
      "An expired running pipeline lease is discoverable and reclaimed without reviving terminal plans",
      runnableAfterLeaseExpiry.includes(expiredPlan.id)
        && recoveredPlan.status === "awaiting_review"
        && recoveredPlan.stages.find((stage) => stage.stageKey === "human_review")?.status === "paused",
      JSON.stringify({ runnableAfterLeaseExpiry, status: recoveredPlan.status, stages: recoveredPlan.stages.map((stage) => ({ key: stage.stageKey, status: stage.status })) }),
    );

    const forcedAt = Date.now();
    await database.prepare(`
      UPDATE pipeline_stage_runs
      SET status = 'succeeded', checkpoint_json = '{}', error = '', finished_at = ?
      WHERE plan_id = ? AND stage_key IN ('knowledge_expand', 'song_generate', 'media_analyze', 'human_review')
    `).run(forcedAt, plan.id);
    await database.prepare(`
      UPDATE pipeline_stage_runs
      SET status = 'queued', checkpoint_json = '{}', error = '', started_at = NULL, finished_at = NULL
      WHERE plan_id = ? AND stage_key = 'notify'
    `).run(plan.id);
    await database.prepare(`
      UPDATE pipeline_plans
      SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, finished_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(forcedAt, plan.id);
    const incompleteCheckpoint = await captureFailure(() => executePipelinePlan(plan.id, `${prefix}-checkpoint-worker`));
    const blockedPlan = await getPipelinePlan(plan.id);
    check(
      "A forged succeeded human stage without a manual checkpoint cannot complete the plan",
      incompleteCheckpoint.threw
        && blockedPlan.status !== "succeeded"
        && !blockedPlan.events.some((event) => event.eventType === "plan.succeeded"),
      JSON.stringify({ failure: incompleteCheckpoint, status: blockedPlan.status, events: blockedPlan.events.map((event) => event.eventType) }),
    );

    const crossRoundCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "cross-round");
    const priorRound = await createPassedRound(database, crossRoundCandidate, 1, users.admin);
    await addAssignedPass(database, priorRound, crossRoundCandidate, 1, "content", users.content, users.admin, "prior");
    await addAssignedPass(database, priorRound, crossRoundCandidate, 1, "music", users.music, users.admin, "prior");
    const currentIncompleteRound = await createPassedRound(database, crossRoundCandidate, 2, users.admin);
    await addAssignedPass(database, currentIncompleteRound, crossRoundCandidate, 2, "content", users.content, users.admin, "current");
    const crossRoundFailure = await captureFailure(() => actOnCandidate(crossRoundCandidate, { action: "approve_master" }, users.admin));
    const crossRoundState = await candidateState(database, crossRoundCandidate);
    check(
      "Candidate approval cannot combine content and music passes from different review rounds",
      crossRoundFailure.threw
        && crossRoundFailure.status === 409
        && crossRoundState.status === "generated"
        && crossRoundState.masterCount === 0,
      JSON.stringify({ failure: crossRoundFailure, state: crossRoundState }),
    );

    const unassignedCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "unassigned");
    await createPassedRound(database, unassignedCandidate, 1, users.admin);
    await addUnassignedPass(database, unassignedCandidate, 1, "content", users.content, "content");
    await addUnassignedPass(database, unassignedCandidate, 1, "music", users.music, "music");
    const unassignedFailure = await captureFailure(() => actOnCandidate(unassignedCandidate, { action: "approve_master" }, users.admin));
    const unassignedState = await candidateState(database, unassignedCandidate);
    check(
      "Legacy candidate reviews without matching assignments cannot approve a master",
      unassignedFailure.threw
        && unassignedFailure.status === 409
        && unassignedState.status === "generated"
        && unassignedState.masterCount === 0,
      JSON.stringify({ failure: unassignedFailure, state: unassignedState }),
    );

    const reviewerConstraint = required(await database.prepare(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'review_assignments'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (review_round_id, reviewer_id)'
    `).get<{ conname: string }>(), "reviewer uniqueness constraint");
    await database.exec(`ALTER TABLE review_assignments DROP CONSTRAINT ${quotedIdentifier(reviewerConstraint.conname)}`);
    const sameReviewerCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "same-reviewer");
    const sameReviewerRound = await createPassedRound(database, sameReviewerCandidate, 1, users.admin);
    await addAssignedPass(database, sameReviewerRound, sameReviewerCandidate, 1, "content", users.content, users.admin, "same-reviewer");
    await addAssignedPass(database, sameReviewerRound, sameReviewerCandidate, 1, "music", users.content, users.admin, "same-reviewer");
    const sameReviewerFailure = await captureFailure(() => actOnCandidate(sameReviewerCandidate, { action: "approve_master" }, users.admin));
    const sameReviewerState = await candidateState(database, sameReviewerCandidate);
    check(
      "Candidate approval rejects two human-review roles completed by the same reviewer",
      sameReviewerFailure.threw
        && sameReviewerFailure.status === 409
        && sameReviewerState.status === "generated"
        && sameReviewerState.masterCount === 0,
      JSON.stringify({ failure: sameReviewerFailure, state: sameReviewerState }),
    );

    const eligibleCandidate = await createGeneratedCandidate(database, prefix, specId, users.admin, "eligible");
    const eligibleRound = await createPassedRound(database, eligibleCandidate, 2, users.admin);
    await addAssignedPass(database, eligibleRound, eligibleCandidate, 2, "content", users.content, users.admin, "eligible");
    await addAssignedPass(database, eligibleRound, eligibleCandidate, 2, "music", users.music, users.admin, "eligible");
    const approvedCandidate = await actOnCandidate(eligibleCandidate, { action: "approve_master" }, users.admin);
    const eligibleState = await candidateState(database, eligibleCandidate);
    check(
      "Only the latest assignment-linked round with distinct content and music passes satisfies approval",
      approvedCandidate.status === "approved"
        && approvedCandidate.master !== null
        && eligibleState.status === "approved"
        && eligibleState.masterCount === 1,
      JSON.stringify({ candidate: { status: approvedCandidate.status, master: approvedCandidate.master?.id ?? null }, state: eligibleState }),
    );

    const approvedOpenRound = requiredString(asRecord(await actOnGovernance({
      resource: "rounds", action: "open", payload: { candidateId: eligibleCandidate },
    }, adminActor)).id, "approved candidate open round id");
    const approvedRoundBefore = required(await database.prepare(`
      SELECT status FROM review_rounds WHERE id = ?
    `).get<{ status: string }>(approvedOpenRound), "approved candidate open round before state");
    const approvedCandidateBeforeChanges = await candidateState(database, eligibleCandidate);
    const approvedRequestChanges = await captureFailure(() => actOnGovernance({
      resource: "rounds",
      action: "request-changes",
      payload: { roundId: approvedOpenRound, notes: "attempt to invalidate an approved master" },
    }, contentActor));
    const approvedRoundAfter = await database.prepare(`
      SELECT status FROM review_rounds WHERE id = ?
    `).get<{ status: string }>(approvedOpenRound);
    const approvedCandidateAfterChanges = await candidateState(database, eligibleCandidate);
    check(
      "Requesting changes on an open round for an approved candidate is rejected without mutating its candidate or master",
      approvedRequestChanges.threw
        && approvedRequestChanges.status === 409
        && approvedRoundAfter?.status === approvedRoundBefore.status
        && approvedCandidateAfterChanges.status === approvedCandidateBeforeChanges.status
        && approvedCandidateAfterChanges.masterCount === approvedCandidateBeforeChanges.masterCount
        && approvedCandidateAfterChanges.masterStatus === approvedCandidateBeforeChanges.masterStatus,
      JSON.stringify({ failure: approvedRequestChanges, round: { before: approvedRoundBefore, after: approvedRoundAfter }, candidate: { before: approvedCandidateBeforeChanges, after: approvedCandidateAfterChanges } }),
    );

    const forgedHash = "f".repeat(64);
    const sentinelAssetId = `${prefix}-trusted-sentinel`;
    const mediaNow = Date.now();
    await database.prepare(`
      INSERT INTO media_assets (
        id, storage_provider, object_key, original_name, media_kind, mime_type, size_bytes,
        content_hash, qiniu_hash, status, uploaded_by, created_at, updated_at
      ) VALUES (?, 'mock', ?, 'trusted-sentinel.wav', 'audio', 'audio/wav', 1024, ?, ?, 'ready', ?, ?, ?)
    `).run(sentinelAssetId, `${prefix}/trusted-sentinel.wav`, forgedHash, forgedHash, users.admin, mediaNow, mediaNow);
    const mockRegistration = await registerMockMediaAsset({
      name: "forged-client-hash.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      mediaKind: "audio",
      contentHash: forgedHash,
    }, users.admin);
    const mockAsset = await getMediaAsset(mockRegistration.assetId);
    const directKey = `${prefix}/direct-forged.wav`;
    await createUploadGrant(database, directKey, users.admin, "direct-forged.wav", 1024);
    const directRegistration = await registerUploadedSongMedia({
      key: directKey,
      hash: forgedHash,
      fsize: 1024,
      mimeType: "audio/wav",
      scene: "general",
      mediaKind: "audio",
      contentHash: forgedHash,
    }, users.admin);
    const directAsset = await getMediaAsset(directRegistration.assetId);
    check(
      "Mock and direct registrations treat a client-supplied other-asset hash only as a hint, never as deduplication proof",
      mockRegistration.assetId !== sentinelAssetId
        && mockRegistration.deduplicated === false
        && mockAsset.contentHash === ""
        && clientContentHash(mockAsset.metadata) === forgedHash
        && directRegistration.assetId !== sentinelAssetId
        && directRegistration.deduplicated === false
        && directRegistration.status === "uploaded"
        && directAsset.status === "uploaded"
        && directAsset.contentHash === ""
        && directAsset.qiniuHash === ""
        && clientContentHash(directAsset.metadata) === forgedHash,
      JSON.stringify({
        mock: { id: mockRegistration.assetId, deduplicated: mockRegistration.deduplicated, contentHash: mockAsset.contentHash },
        direct: { id: directRegistration.assetId, deduplicated: directRegistration.deduplicated, contentHash: directAsset.contentHash, qiniuHash: directAsset.qiniuHash },
      }),
    );

    const unverifiedPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "create",
      payload: {
        kind: "album",
        slug: `${prefix}-unverified-media`,
        title: "Unverified media admission contract",
        description: "Reject media that has not received server-side integrity verification.",
        audience: "4-6",
        scene: "learning",
        metadata: { contract: "unverified-media" },
      },
    }, adminActor));
    const unverifiedPublicationId = requiredString(asRecord(unverifiedPublication.publication).id, "unverified media publication id");
    const directMediaAdmissionFailure = await captureFailure(() => executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId: unverifiedPublicationId, itemType: "media", itemId: directRegistration.assetId, label: "direct unverified upload" },
    }, adminActor));
    const emptyHashMediaId = `${prefix}-empty-hash-media`;
    const catalogNow = Date.now();
    await database.prepare(`
      INSERT INTO media_assets (
        id, storage_provider, object_key, original_name, media_kind, mime_type, size_bytes,
        content_hash, qiniu_hash, status, metadata_json, uploaded_by, created_at, updated_at
      ) VALUES (?, 'qiniu', ?, 'empty-hash.wav', 'audio', 'audio/wav', 2048, '', '', 'ready', ?, ?, ?, ?)
    `).run(
      emptyHashMediaId,
      `${prefix}/empty-hash.wav`,
      JSON.stringify({ integrity: { verification: "unverified", reason: "legacy empty hash fixture" } }),
      users.admin,
      catalogNow,
      catalogNow,
    );
    const emptyHashMediaAdmissionFailure = await captureFailure(() => executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId: unverifiedPublicationId, itemType: "media", itemId: emptyHashMediaId, label: "ready but empty hash" },
    }, adminActor));
    const rejectedMediaItemCount = await database.prepare(`
      SELECT COUNT(*)::int AS count
      FROM publication_items pi
      JOIN publication_revisions pr ON pr.id = pi.publication_revision_id
      WHERE pr.publication_id = ?
    `).get<{ count: number }>(unverifiedPublicationId);

    const trustedMediaId = `${prefix}-trusted-publication-media`;
    const trustedMediaHash = "e".repeat(64);
    await database.prepare(`
      INSERT INTO media_assets (
        id, storage_provider, object_key, original_name, media_kind, mime_type, size_bytes,
        content_hash, qiniu_hash, status, metadata_json, uploaded_by, created_at, updated_at
      ) VALUES (?, 'qiniu', ?, 'trusted-publication.wav', 'audio', 'audio/wav', 4096, ?, 'trusted-qiniu-hash', 'ready', ?, ?, ?, ?)
    `).run(
      trustedMediaId,
      `${prefix}/trusted-publication.wav`,
      trustedMediaHash,
      JSON.stringify({ integrity: { verification: "verified", verifiedBy: "contract fixture" } }),
      users.admin,
      catalogNow,
      catalogNow,
    );

    const snapshotPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "create",
      payload: {
        kind: "album",
        slug: `${prefix}-snapshot-drift`,
        title: "Publication snapshot drift contract",
        description: "Publish must validate the immutable item snapshot.",
        audience: "4-6",
        scene: "learning",
        metadata: { contract: "snapshot-drift" },
      },
    }, adminActor));
    const snapshotPublicationId = requiredString(asRecord(snapshotPublication.publication).id, "snapshot drift publication id");
    const snapshotAddedMedia = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId: snapshotPublicationId, itemType: "media", itemId: trustedMediaId, label: "trusted media" },
    }, adminActor));
    const snapshotRevisionId = requiredString(asRecord(snapshotAddedMedia.revision).id, "snapshot drift publication revision id");
    await executeCatalogMutation({
      resource: "rights",
      action: "create",
      payload: { subjectType: "publication", subjectId: snapshotPublicationId, holder: "CCMS contract", license: "test-only", territory: "global", evidence: "snapshot drift fixture" },
    }, adminActor);
    await executeCatalogMutation({ resource: "publications", action: "submit", payload: { publicationId: snapshotPublicationId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "evaluate", payload: { publicationRevisionId: snapshotRevisionId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "final-pass", payload: { publicationRevisionId: snapshotRevisionId } }, adminActor);

    const releasePublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "create",
      payload: {
        kind: "album",
        slug: `${prefix}-media-release`,
        title: "Media release integrity contract",
        description: "Release must revalidate media integrity.",
        audience: "4-6",
        scene: "learning",
        metadata: { contract: "media-release" },
      },
    }, adminActor));
    const releasePublicationId = requiredString(asRecord(releasePublication.publication).id, "media release publication id");
    const releaseAddedMedia = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId: releasePublicationId, itemType: "media", itemId: trustedMediaId, label: "trusted release media" },
    }, adminActor));
    const releaseRevisionId = requiredString(asRecord(releaseAddedMedia.revision).id, "media release publication revision id");
    await executeCatalogMutation({
      resource: "rights",
      action: "create",
      payload: { subjectType: "publication", subjectId: releasePublicationId, holder: "CCMS contract", license: "test-only", territory: "global", evidence: "media release fixture" },
    }, adminActor);
    await executeCatalogMutation({ resource: "publications", action: "submit", payload: { publicationId: releasePublicationId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "evaluate", payload: { publicationRevisionId: releaseRevisionId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "final-pass", payload: { publicationRevisionId: releaseRevisionId } }, adminActor);
    const publishedReleasePublication = asRecord(await executeCatalogMutation({
      resource: "publications", action: "publish", payload: { publicationId: releasePublicationId },
    }, adminActor));
    const draftRelease = asRecord(await executeCatalogMutation({
      resource: "releases", action: "create", payload: { publicationId: releasePublicationId },
    }, adminActor));
    const draftReleaseId = requiredString(asRecord(draftRelease.release).id, "unverified media release id");

    const parentPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "create",
      payload: {
        kind: "collection",
        slug: `${prefix}-nested-media-parent`,
        title: "Nested media integrity contract",
        description: "Nested publications must retain a verified media closure.",
        audience: "4-6",
        scene: "learning",
        metadata: { contract: "nested-media" },
      },
    }, adminActor));
    const parentPublicationId = requiredString(asRecord(parentPublication.publication).id, "nested media parent publication id");
    const parentAddedChild = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId: parentPublicationId, itemType: "publication", itemId: releasePublicationId, label: "published child" },
    }, adminActor));
    const parentRevisionId = requiredString(asRecord(parentAddedChild.revision).id, "nested media parent revision id");
    await executeCatalogMutation({
      resource: "rights",
      action: "create",
      payload: { subjectType: "publication", subjectId: parentPublicationId, holder: "CCMS contract", license: "test-only", territory: "global", evidence: "nested media fixture" },
    }, adminActor);
    await executeCatalogMutation({ resource: "publications", action: "submit", payload: { publicationId: parentPublicationId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "evaluate", payload: { publicationRevisionId: parentRevisionId } }, adminActor);
    await actOnGovernance({ resource: "gates", action: "final-pass", payload: { publicationRevisionId: parentRevisionId } }, adminActor);

    const snapshotItem = required(await database.prepare(`
      SELECT id, snapshot_hash FROM publication_items WHERE publication_revision_id = ?
    `).get<{ id: string; snapshot_hash: string }>(snapshotRevisionId), "snapshot drift publication item");
    await database.prepare("UPDATE publication_items SET snapshot_hash = ? WHERE id = ?").run("0".repeat(64), snapshotItem.id);
    const snapshotPublishFailure = await captureFailure(() => executeCatalogMutation({
      resource: "publications", action: "publish", payload: { publicationId: snapshotPublicationId },
    }, adminActor));
    const snapshotPublicationState = await database.prepare("SELECT status FROM publications WHERE id = ?").get<{ status: string }>(snapshotPublicationId);
    check(
      "Publication item snapshot drift blocks publish and leaves the publication in review",
      snapshotPublishFailure.threw
        && snapshotPublishFailure.status === 409
        && snapshotPublicationState?.status === "review",
      JSON.stringify({ failure: snapshotPublishFailure, publication: snapshotPublicationState }),
    );
    await database.prepare("UPDATE publication_items SET snapshot_hash = ? WHERE id = ?").run(snapshotItem.snapshot_hash, snapshotItem.id);

    await database.prepare(`
      UPDATE media_assets
      SET content_hash = '', qiniu_hash = '', metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify({ integrity: { verification: "unverified", reason: "post-publication integrity loss" } }), Date.now(), trustedMediaId);
    const nestedMediaPublishFailure = await captureFailure(() => executeCatalogMutation({
      resource: "publications", action: "publish", payload: { publicationId: parentPublicationId },
    }, adminActor));
    const nestedMediaPublicationState = await database.prepare("SELECT status FROM publications WHERE id = ?").get<{ status: string }>(parentPublicationId);

    const emptyHashPublishFailure = await captureFailure(() => executeCatalogMutation({
      resource: "publications", action: "publish", payload: { publicationId: snapshotPublicationId },
    }, adminActor));
    const emptyHashPublicationState = await database.prepare("SELECT status FROM publications WHERE id = ?").get<{ status: string }>(snapshotPublicationId);
    const emptyHashReleaseFailure = await captureFailure(() => executeCatalogMutation({
      resource: "releases", action: "release", payload: { releaseId: draftReleaseId },
    }, adminActor));
    const emptyHashReleaseState = await database.prepare("SELECT status FROM release_packages WHERE id = ?").get<{ status: string }>(draftReleaseId);
    check(
      "Unverified direct, empty-hash, or nested invalid media cannot enter, publish, or release a publication",
      directRegistration.status === "uploaded"
        && directAsset.status === "uploaded"
        && directMediaAdmissionFailure.threw
        && emptyHashMediaAdmissionFailure.threw
        && rejectedMediaItemCount?.count === 0
        && publishedReleasePublication.status === "published"
        && nestedMediaPublishFailure.threw
        && nestedMediaPublicationState?.status === "review"
        && emptyHashPublishFailure.threw
        && emptyHashPublicationState?.status === "review"
        && emptyHashReleaseFailure.threw
        && emptyHashReleaseState?.status === "draft",
      JSON.stringify({
        direct: { status: directRegistration.status, assetStatus: directAsset.status, admission: directMediaAdmissionFailure },
        emptyHashAdmission: { failure: emptyHashMediaAdmissionFailure, itemCount: rejectedMediaItemCount?.count ?? null },
        nestedPublication: { failure: nestedMediaPublishFailure, publication: nestedMediaPublicationState },
        publish: { failure: emptyHashPublishFailure, publication: emptyHashPublicationState },
        release: { failure: emptyHashReleaseFailure, release: emptyHashReleaseState },
      }),
    );

    const unavailableProbe = await extractMediaTechnicalMetadata(join(dataDir, "missing-media.wav"), 1024);
    const analysisClaimed = await beginSongMediaAnalysis(directRegistration.songId);
    const analyzedHash = "a".repeat(64);
    await markSongMediaAnalysisFailed(directRegistration.songId, unavailableProbe.error ?? "ffprobe failure", analyzedHash);
    const failedAsset = await getMediaAsset(directRegistration.assetId);
    check(
      "An unavailable ffprobe path maps the analyzing asset to failed rather than ready",
      unavailableProbe.ffprobeAvailable === false
        && analysisClaimed
        && failedAsset.status === "failed"
        && failedAsset.contentHash === analyzedHash,
      JSON.stringify({ probe: unavailableProbe, claimed: analysisClaimed, asset: { status: failedAsset.status, contentHash: failedAsset.contentHash } }),
    );

    const lateKey = `${prefix}/late-result.wav`;
    await createUploadGrant(database, lateKey, users.admin, "late-result.wav", 2048);
    const lateRegistration = await registerUploadedSongMedia({
      key: lateKey,
      hash: "client-only-qiniu-hash",
      fsize: 2048,
      mimeType: "audio/wav",
      scene: "general",
      mediaKind: "audio",
      contentHash: "b".repeat(64),
    }, users.admin);
    const lateClaimed = await beginSongMediaAnalysis(lateRegistration.songId);
    await database.prepare("UPDATE media_assets SET status = 'rejected' WHERE id = ?").run(lateRegistration.assetId);
    await syncSongMediaAnalysis({
      songId: lateRegistration.songId,
      durationSec: 12,
      sampleRate: 44_100,
      channels: 2,
      analyzedSizeBytes: 2048,
      trustedContentHash: "c".repeat(64),
      reportId: `${prefix}-late-rejected`,
      passed: true,
      total: 92,
      analyzerVersion: "ccms-contract",
      notes: "late successful result",
    });
    const rejectedAfterLateSuccess = await getMediaAsset(lateRegistration.assetId);
    await database.prepare("UPDATE media_assets SET status = 'retired' WHERE id = ?").run(lateRegistration.assetId);
    await syncSongMediaAnalysis({
      songId: lateRegistration.songId,
      durationSec: 12,
      sampleRate: 44_100,
      channels: 2,
      analyzedSizeBytes: 2048,
      trustedContentHash: "d".repeat(64),
      reportId: `${prefix}-late-retired`,
      passed: true,
      total: 92,
      analyzerVersion: "ccms-contract",
      notes: "late successful result after retirement",
    });
    const retiredAfterLateSuccess = await getMediaAsset(lateRegistration.assetId);
    check(
      "Late successful analysis cannot revive rejected or retired media into ready",
      lateClaimed
        && rejectedAfterLateSuccess.status === "rejected"
        && rejectedAfterLateSuccess.contentHash === ""
        && retiredAfterLateSuccess.status === "retired"
        && retiredAfterLateSuccess.contentHash === "",
      JSON.stringify({
        claimed: lateClaimed,
        rejected: { status: rejectedAfterLateSuccess.status, contentHash: rejectedAfterLateSuccess.contentHash },
        retired: { status: retiredAfterLateSuccess.status, contentHash: retiredAfterLateSuccess.contentHash },
      }),
    );

    const auditFailureFunction = `ccms_audit_failure_${randomUUID().replaceAll("-", "")}`;
    const auditFailureTrigger = `ccms_audit_failure_trigger_${randomUUID().replaceAll("-", "")}`;
    await database.exec(`
      CREATE FUNCTION ${quotedIdentifier(auditFailureFunction)}() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'pipeline_template.create' THEN
          RAISE EXCEPTION 'ccms contract forced audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.exec(`
      CREATE TRIGGER ${quotedIdentifier(auditFailureTrigger)}
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION ${quotedIdentifier(auditFailureFunction)}()
    `);
    const blockedTemplateKey = `${prefix}-audit-rollback`;
    const auditFailure = await captureFailure(() => createPipelineTemplate({
      templateKey: blockedTemplateKey,
      name: "Audit failure rollback",
      stages: standardStages(),
    }, users.admin));
    const blockedTemplateCount = await database.prepare(`
      SELECT COUNT(*)::int AS count FROM pipeline_templates WHERE template_key = ?
    `).get<{ count: number }>(blockedTemplateKey);
    const blockedRevisionCount = await database.prepare(`
      SELECT COUNT(*)::int AS count
      FROM pipeline_template_revisions r
      JOIN pipeline_templates t ON t.id = r.template_id
      WHERE t.template_key = ?
    `).get<{ count: number }>(blockedTemplateKey);
    const blockedAuditCount = await database.prepare(`
      SELECT COUNT(*)::int AS count
      FROM audit_log
      WHERE action = 'pipeline_template.create' AND detail_json::jsonb ->> 'templateKey' = ?
    `).get<{ count: number }>(blockedTemplateKey);
    check(
      "A forced audit insert failure rolls the template mutation and revision back with no residual audit",
      auditFailure.threw
        && blockedTemplateCount?.count === 0
        && blockedRevisionCount?.count === 0
        && blockedAuditCount?.count === 0,
      JSON.stringify({ failure: auditFailure, templateRows: blockedTemplateCount?.count ?? null, revisionRows: blockedRevisionCount?.count ?? null, auditRows: blockedAuditCount?.count ?? null }),
    );
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    const cleanup = async (label: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (closeDatabase) await cleanup("close application database", closeDatabase);
    if (controlConnected && schemaCreated) {
      await cleanup("drop generated schema", async () => {
        await control.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      });
    }
    if (controlConnected) await cleanup("close control database connection", () => control.end());
    if (dataDir) await cleanup("remove temporary HUM_DATA_DIR", () => rm(dataDir!, { recursive: true, force: true }));
    restoreEnvironment("DATABASE_URL", originalDatabaseUrl);
    restoreEnvironment("HUM_DATA_DIR", originalDataDir);

    if (cleanupFailures.length) {
      const message = `CCMS contract cleanup failed: ${cleanupFailures.join("; ")}`;
      if (workError) console.error(message);
      else throw new Error(message);
    }
  }
}

void main()
  .then(() => {
    console.log(failed ? `\n${failed} contract checks failed` : "\nall CCMS integrity contracts passed");
    process.exitCode = failed ? 1 : 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
