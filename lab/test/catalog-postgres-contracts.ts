/**
 * PostgreSQL catalog migration and release-snapshot contracts.
 *
 * Requires an explicitly marked isolated database:
 *   HUM_POSTGRES_CONTRACT_TEST=1
 *   DATABASE_URL=postgresql://…/hum_catalog_contract_test
 *
 * The script creates one generated schema inside that database and drops only
 * that schema during cleanup. It never drops or truncates a database.
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20{}",
      };
    }

    if (NEXT_EXTENSIONLESS_SUBPATHS.has(specifier)) {
      try {
        return nextResolve(`${specifier}.js`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }

    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && extname(specifier) === ""
    ) {
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
}

type ReleaseRow = {
  id: string;
  status: string;
  publication_revision_id: string;
  manifest_json: string;
  content_hash: string;
};

const ISOLATED_DATABASE_NAME = /(?:^|[_-])(?:test|tests|contract)(?:[_-]|$)/i;
let failed = 0;

function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned no object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function targetDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("Refusing catalog contract test: DATABASE_URL must explicitly name an isolated test database");
  if (process.env.HUM_POSTGRES_CONTRACT_TEST !== "1") {
    throw new Error("Refusing catalog contract test: set HUM_POSTGRES_CONTRACT_TEST=1 for an isolated database");
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("Refusing catalog contract test: DATABASE_URL is not a valid PostgreSQL URL");
  }

  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("Refusing catalog contract test: DATABASE_URL must use postgres or postgresql");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, ""));
  if (!databaseName || databaseName.includes("/") || !ISOLATED_DATABASE_NAME.test(databaseName)) {
    throw new Error("Refusing catalog contract test: DATABASE_URL database name must contain a test or contract marker");
  }
  return target;
}

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe generated PostgreSQL schema name");
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

function errorSummary(error: unknown): { status: unknown; message: string } {
  if (error instanceof Error) {
    return {
      status: "status" in error ? (error as Error & { status?: unknown }).status : undefined,
      message: error.message,
    };
  }
  return { status: undefined, message: String(error) };
}

async function expectConflict(name: string, action: () => Promise<unknown>, expectedMessage: string) {
  let error: unknown = new Error("no error");
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  const observed = errorSummary(error);
  check(name, observed.status === 409 && observed.message === expectedMessage, JSON.stringify(observed));
}

async function checkReleaseStatus(database: TestDatabase, releaseId: string, expected: "draft" | "released", name: string) {
  const row = await database.prepare("SELECT status FROM release_packages WHERE id = ?").get<{ status: string }>(releaseId);
  check(name, row?.status === expected, JSON.stringify(row ?? null));
}

async function readRelease(database: TestDatabase, releaseId: string): Promise<ReleaseRow> {
  const row = await database.prepare(`
    SELECT id, status, publication_revision_id, manifest_json, content_hash
    FROM release_packages
    WHERE id = ?
  `).get<ReleaseRow>(releaseId);
  if (!row) throw new Error(`Release ${releaseId} was not created`);
  return row;
}

async function main() {
  const target = targetDatabaseUrl();
  const schema = `hum_catalog_contract_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quotedIdentifier(schema);
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

    dataDir = await mkdtemp(join(tmpdir(), "hum-catalog-contract-"));
    process.env.HUM_DATA_DIR = dataDir;
    process.env.DATABASE_URL = scopedDatabaseUrl(target, schema);

    const [
      { closeDatabase: close, getDb, waitForDatabase },
      { executeCatalogMutation, listCatalog },
      { actOnGovernance },
      { listMediaAssets, registerMockMediaAsset },
    ] = await Promise.all([
      import("../lib/server/database.ts"),
      import("../lib/server/catalog.ts"),
      import("../lib/server/governance.ts"),
      import("../lib/server/media.ts"),
    ]);
    closeDatabase = close;
    await waitForDatabase();
    const database = getDb() as unknown as TestDatabase;

    const activeSchema = await database.prepare("SELECT current_schema() AS schema").get<{ schema: string }>();
    if (activeSchema?.schema !== schema) throw new Error("Catalog contract test did not receive its generated PostgreSQL schema");

    const seedPublicationIds = ["seed-publication-book", "seed-publication-album"];
    const seedRevisionIds = ["seed-publication-book-r1", "seed-publication-album-r1"];
    const seedPublications = await database.prepare(`
      SELECT id, status
      FROM publications
      WHERE id IN (?, ?)
      ORDER BY id ASC
    `).all<{ id: string; status: string }>(...seedPublicationIds);
    check(
      "v5 resets both seeded publications to draft",
      seedPublications.length === seedPublicationIds.length && seedPublications.every((publication) => publication.status === "draft"),
      JSON.stringify(seedPublications),
    );

    const seededPackages = await database.prepare(`
      SELECT publication_revision_id, status
      FROM release_packages
      WHERE publication_revision_id IN (?, ?)
      ORDER BY publication_revision_id ASC, id ASC
    `).all<{ publication_revision_id: string; status: string }>(...seedRevisionIds);
    check(
      "v5 recalls seed release packages if present",
      seededPackages.every(
        (releasePackage) => seedRevisionIds.includes(releasePackage.publication_revision_id) && releasePackage.status === "recalled",
      ),
      JSON.stringify(seededPackages),
    );

    const seedGateCount = await database.prepare(`
      SELECT COUNT(*)::int AS count
      FROM release_gate_checks
      WHERE publication_revision_id IN (?, ?)
    `).get<{ count: number }>(...seedRevisionIds);
    check(
      "v5 removes seeded publication release gates",
      seedGateCount?.count === 0,
      JSON.stringify(seedGateCount ?? null),
    );

    const publicDraftSeeds = await listCatalog({ resource: "publications", page: 1, pageSize: 100, status: "draft" });
    const listedSeedIds = new Set((publicDraftSeeds.items as Array<{ id?: unknown; status?: unknown }>)
      .filter((item) => item.status === "draft")
      .map((item) => item.id));
    check(
      "Catalog service exposes the v5 seed reset as draft state",
      seedPublicationIds.every((id) => listedSeedIds.has(id)),
      JSON.stringify([...listedSeedIds]),
    );

    const actor = {
      id: randomUUID(),
      username: `catalog-contract-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      displayName: "Catalog contract admin",
      role: "admin" as const,
    };
    const now = Date.now();
    await database.prepare(`
      INSERT INTO users (id, username, display_name, password_salt, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(actor.id, actor.username, actor.displayName, "contract-salt", "contract-hash", actor.role, now, now);

    const duplicateMediaName = `v6-owner-hash-${schema}.wav`;
    const firstMedia = await registerMockMediaAsset({
      name: duplicateMediaName,
      mimeType: "audio/wav",
      sizeBytes: 2_048,
      mediaKind: "audio",
    }, actor.id);
    const secondMedia = await registerMockMediaAsset({
      name: duplicateMediaName,
      mimeType: "audio/wav",
      sizeBytes: 2_048,
      mediaKind: "audio",
    }, actor.id);
    const duplicateContentHash = "a".repeat(64);
    let duplicateMutationError: unknown;
    try {
      await database.prepare("UPDATE media_assets SET status = 'failed', content_hash = ? WHERE id = ?").run(duplicateContentHash, firstMedia.assetId);
      await database.prepare("UPDATE media_assets SET status = 'failed', content_hash = ? WHERE id = ?").run(duplicateContentHash, secondMedia.assetId);
    } catch (error) {
      duplicateMutationError = error;
    }
    const ownerHashRows = await database.prepare(`
      SELECT id, status, content_hash, uploaded_by
      FROM media_assets
      WHERE uploaded_by = ? AND content_hash = ?
      ORDER BY id ASC
    `).all<{ id: string; status: string; content_hash: string; uploaded_by: string }>(actor.id, duplicateContentHash);
    check(
      "v6 permits failed media with the same owner and content hash",
      !duplicateMutationError
        && ownerHashRows.length === 2
        && ownerHashRows.every((asset) => asset.status === "failed" && asset.uploaded_by === actor.id),
      JSON.stringify({ error: duplicateMutationError ? errorSummary(duplicateMutationError) : null, rows: ownerHashRows }),
    );

    const listedFailedMedia = await listMediaAssets({ status: "failed", search: duplicateMediaName, page: 1, pageSize: 10 });
    const listedFailedIds = new Set(listedFailedMedia.items.map((asset) => asset.id));
    check(
      "Media service returns both v6 failed duplicate-hash assets",
      listedFailedIds.has(firstMedia.assetId) && listedFailedIds.has(secondMedia.assetId),
      JSON.stringify([...listedFailedIds]),
    );

    const knowledgeItem = await database.prepare(`
      SELECT i.id
      FROM knowledge_items i
      JOIN knowledge_item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
      WHERE i.status = 'published'
      ORDER BY i.id ASC
      LIMIT 1
    `).get<{ id: string }>();
    if (!knowledgeItem) throw new Error("Catalog contract fixture requires a published knowledge item");

    const slugSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const createdPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "create",
      payload: {
        kind: "book",
        slug: `catalog-contract-${slugSuffix}`,
        title: "Catalog release contract",
        description: "Isolated PostgreSQL release snapshot contract fixture",
        audience: "4-6",
        scene: "learning",
        metadata: { suite: "catalog-postgres-contracts" },
      },
    }, actor), "publication creation");
    const publication = asRecord(createdPublication.publication, "publication creation result");
    const publicationId = requiredString(publication.id, "publication id");

    const addedItem = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "add-item",
      payload: { publicationId, itemType: "knowledge", itemId: knowledgeItem.id, label: "Published fixture" },
    }, actor), "publication item creation");
    const revisionTwo = asRecord(addedItem.revision, "publication item revision");
    const revisionTwoId = requiredString(revisionTwo.id, "second publication revision id");

    const revisedPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "revise",
      payload: {
        publicationId,
        title: "Catalog release contract revised",
        description: "Current revision used to prove release snapshot integrity",
        metadata: { suite: "catalog-postgres-contracts", revision: "current" },
      },
    }, actor), "publication revision");
    const revisionThree = asRecord(revisedPublication.revision, "current publication revision");
    const revisionThreeId = requiredString(revisionThree.id, "current publication revision id");

    const publicationRevisions = await database.prepare(`
      SELECT id, revision
      FROM publication_revisions
      WHERE id IN (?, ?)
    `).all<{ id: string; revision: number }>(revisionTwoId, revisionThreeId);
    const revisionTwoNumber = publicationRevisions.find((revision) => revision.id === revisionTwoId)?.revision;
    const revisionThreeNumber = publicationRevisions.find((revision) => revision.id === revisionThreeId)?.revision;
    if (!revisionTwoNumber || !revisionThreeNumber || revisionTwoNumber === revisionThreeNumber) {
      throw new Error("Catalog contract fixture did not create distinct publication revisions");
    }

    await executeCatalogMutation({
      resource: "rights",
      action: "create",
      payload: {
        subjectType: "publication",
        subjectId: publicationId,
        holder: "Catalog contract fixture",
        license: "test-only",
        territory: "global",
        evidence: "isolated PostgreSQL contract fixture",
      },
    }, actor);
    await executeCatalogMutation({ resource: "publications", action: "submit", payload: { publicationId } }, actor);
    await actOnGovernance({ resource: "gates", action: "evaluate", payload: { publicationRevisionId: revisionThreeId } }, actor);
    await actOnGovernance({ resource: "gates", action: "final-pass", payload: { publicationRevisionId: revisionThreeId } }, actor);
    const publishedPublication = asRecord(await executeCatalogMutation({
      resource: "publications",
      action: "publish",
      payload: { publicationId },
    }, actor), "publication publish");
    check(
      "A current publication becomes published only after its gates pass",
      publishedPublication.status === "published",
      JSON.stringify(publishedPublication),
    );

    let staleReleaseId = "";
    await database.prepare("UPDATE publications SET current_revision = ? WHERE id = ?").run(revisionTwoNumber, publicationId);
    try {
      const staleRelease = asRecord(await executeCatalogMutation({
        resource: "releases",
        action: "create",
        payload: { publicationId },
      }, actor), "stale release creation");
      staleReleaseId = requiredString(asRecord(staleRelease.release, "stale release result").id, "stale release id");
    } finally {
      await database.prepare("UPDATE publications SET current_revision = ? WHERE id = ?").run(revisionThreeNumber, publicationId);
    }
    await expectConflict(
      "ReleasePackage rejects a package for a non-current publication revision",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: staleReleaseId } }, actor),
      "发布包必须引用当前出版物修订",
    );
    await checkReleaseStatus(database, staleReleaseId, "draft", "Rejected non-current package remains draft in PostgreSQL");

    const gatedRelease = asRecord(await executeCatalogMutation({
      resource: "releases",
      action: "create",
      payload: { publicationId },
    }, actor), "current release creation");
    const gatedReleaseId = requiredString(asRecord(gatedRelease.release, "current release result").id, "current release id");
    const gatedReleaseRow = await readRelease(database, gatedReleaseId);
    check(
      "A legal current snapshot creates a draft ReleasePackage",
      gatedReleaseRow.status === "draft" && gatedReleaseRow.publication_revision_id === revisionThreeId,
      JSON.stringify({ status: gatedReleaseRow.status, revisionId: gatedReleaseRow.publication_revision_id }),
    );

    await database.prepare(`
      DELETE FROM release_gate_checks
      WHERE publication_revision_id = ? AND gate_key = 'final_approval'
    `).run(revisionThreeId);
    await expectConflict(
      "A legal current ReleasePackage still requires final approval to release",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: gatedReleaseId } }, actor),
      "发布需要 A 级最终审核通过",
    );
    await checkReleaseStatus(database, gatedReleaseId, "draft", "Gate-blocked current package remains draft in PostgreSQL");

    await actOnGovernance({ resource: "gates", action: "final-pass", payload: { publicationRevisionId: revisionThreeId } }, actor);
    const releasedPackage = asRecord(await executeCatalogMutation({
      resource: "releases",
      action: "release",
      payload: { releaseId: gatedReleaseId },
    }, actor), "gated release");
    check(
      "A legal current ReleasePackage releases after final approval",
      releasedPackage.status === "released",
      JSON.stringify(releasedPackage),
    );
    await checkReleaseStatus(database, gatedReleaseId, "released", "Gated current package persists as released in PostgreSQL");

    const driftRelease = asRecord(await executeCatalogMutation({
      resource: "releases",
      action: "create",
      payload: { publicationId },
    }, actor), "drift release creation");
    const driftReleaseId = requiredString(asRecord(driftRelease.release, "drift release result").id, "drift release id");
    const originalRelease = await readRelease(database, driftReleaseId);
    const currentItem = await database.prepare(`
      SELECT id, snapshot_hash
      FROM publication_items
      WHERE publication_revision_id = ?
      ORDER BY position ASC
      LIMIT 1
    `).get<{ id: string; snapshot_hash: string }>(revisionThreeId);
    if (!currentItem) throw new Error("Catalog contract fixture has no current publication item");

    await database.prepare("UPDATE publication_items SET snapshot_hash = ? WHERE id = ?").run("b".repeat(64), currentItem.id);
    await expectConflict(
      "ReleasePackage rejects a drifted publication item snapshot hash",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: driftReleaseId } }, actor),
      "出版物项快照已漂移，请创建新修订后重新通过发布门禁",
    );
    await checkReleaseStatus(database, driftReleaseId, "draft", "Snapshot-drift rejection leaves package draft in PostgreSQL");
    await database.prepare("UPDATE publication_items SET snapshot_hash = ? WHERE id = ?").run(currentItem.snapshot_hash, currentItem.id);

    const originalManifest = asRecord(JSON.parse(originalRelease.manifest_json), "release manifest");
    const originalManifestRevision = asRecord(originalManifest.revision, "release manifest revision");
    const driftedManifest = JSON.stringify({
      ...originalManifest,
      revision: { ...originalManifestRevision, contentHash: "c".repeat(64) },
    });
    await database.prepare("UPDATE release_packages SET manifest_json = ? WHERE id = ?").run(driftedManifest, driftReleaseId);
    await expectConflict(
      "ReleasePackage rejects a drifted manifest",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: driftReleaseId } }, actor),
      "发布包快照与当前出版物修订不一致",
    );
    await checkReleaseStatus(database, driftReleaseId, "draft", "Manifest-drift rejection leaves package draft in PostgreSQL");
    await database.prepare("UPDATE release_packages SET manifest_json = ? WHERE id = ?").run(originalRelease.manifest_json, driftReleaseId);

    await database.prepare("UPDATE release_packages SET content_hash = ? WHERE id = ?").run("d".repeat(64), driftReleaseId);
    await expectConflict(
      "ReleasePackage rejects a drifted manifest content hash",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: driftReleaseId } }, actor),
      "发布包快照与当前出版物修订不一致",
    );
    await checkReleaseStatus(database, driftReleaseId, "draft", "Content-hash rejection leaves package draft in PostgreSQL");
    await database.prepare("UPDATE release_packages SET content_hash = ? WHERE id = ?").run(originalRelease.content_hash, driftReleaseId);

    const originalRevision = await database.prepare("SELECT content_hash FROM publication_revisions WHERE id = ?").get<{ content_hash: string }>(revisionThreeId);
    if (!originalRevision) throw new Error("Current publication revision disappeared");
    await database.prepare("UPDATE publication_revisions SET content_hash = ? WHERE id = ?").run("e".repeat(64), revisionThreeId);
    await expectConflict(
      "ReleasePackage rejects a drifted current revision content hash",
      () => executeCatalogMutation({ resource: "releases", action: "release", payload: { releaseId: driftReleaseId } }, actor),
      "出版物当前修订快照哈希不一致",
    );
    await checkReleaseStatus(database, driftReleaseId, "draft", "Revision-hash rejection leaves package draft in PostgreSQL");
    await database.prepare("UPDATE publication_revisions SET content_hash = ? WHERE id = ?").run(originalRevision.content_hash, revisionThreeId);
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
      const message = `Catalog contract cleanup failed: ${cleanupFailures.join("; ")}`;
      if (workError) console.error(message);
      else throw new Error(message);
    }
  }
}

void main()
  .then(() => {
    console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
    process.exitCode = failed ? 1 : 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
