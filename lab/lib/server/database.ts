import "server-only";

import { createHash } from "node:crypto";
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { DATABASE_MIGRATIONS } from "./database-migrations";

types.setTypeParser(20, (value) => Number(value));

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | string;
}

type Queryable = Pick<Pool | PoolClient, "query">;

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("缺少 DATABASE_URL；hum 已迁移到 PostgreSQL，不再读取 SQLite 运行时数据库");
  return value;
}

function translateSql(sql: string): string {
  let translated = "";
  let parameter = 0;
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      translated += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          translated += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      translated += character;
      continue;
    }
    if (character === "?") {
      parameter += 1;
      translated += `$${parameter}`;
      continue;
    }
    translated += character;
  }

  return translated.replace(/\bAS\s+([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g, 'AS "$1"');
}

class PgStatement {
  constructor(
    private readonly database: HumDatabase,
    private readonly sql: string,
    private readonly firstColumnOnly = false,
  ) {}

  pluck(): PgStatement {
    return new PgStatement(this.database, this.sql, true);
  }

  async run(...params: unknown[]): Promise<RunResult> {
    const result = await this.database.query(this.sql, params);
    const first = result.rows[0] as Record<string, unknown> | undefined;
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: first?.id as number | string | undefined,
    };
  }

  async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
    const result = await this.database.query(this.sql, params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (this.firstColumnOnly) return Object.values(row)[0] as T;
    return row as T;
  }

  async all<T = unknown>(...params: unknown[]): Promise<T[]> {
    const result = await this.database.query(this.sql, params);
    if (this.firstColumnOnly) return result.rows.map((row) => Object.values(row as Record<string, unknown>)[0] as T);
    return result.rows as T[];
  }
}

export class HumDatabase {
  constructor(
    private readonly queryable: Queryable,
    private readonly ready: Promise<void>,
    private readonly pool?: Pool,
  ) {}

  prepare(sql: string): PgStatement {
    return new PgStatement(this, sql);
  }

  async exec(sql: string): Promise<void> {
    await this.ready;
    await this.queryable.query(sql);
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    await this.ready;
    return this.queryable.query<T>(translateSql(sql), params);
  }

  transaction<T>(operation: (database: HumDatabase) => Promise<T> | T): () => Promise<T> {
    return async () => {
      await this.ready;
      if (!this.pool) return operation(this);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const transaction = new HumDatabase(client, Promise.resolve());
        const result = await operation(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
  }
}

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('hum-database-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      )
    `);
    const applied = await client.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations");
    const checksums = new Map(applied.rows.map((row) => [row.version, row.checksum]));

    for (const migration of DATABASE_MIGRATIONS) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const previous = checksums.get(migration.version);
      if (previous) {
        if (previous !== checksum) throw new Error(`数据库迁移 ${migration.version} 已被修改`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)",
          [migration.version, migration.name, checksum, Date.now()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('hum-database-migrations'))").catch(() => undefined);
    client.release();
  }
}

function openDatabase(): { database: HumDatabase; pool: Pool; ready: Promise<void> } {
  const pool = new Pool({
    connectionString: databaseUrl(),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const ready = applyMigrations(pool);
  return { database: new HumDatabase(pool, ready, pool), pool, ready };
}

declare global {
  // eslint-disable-next-line no-var
  var __humDatabase: HumDatabase | undefined;
  // eslint-disable-next-line no-var
  var __humDatabasePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __humDatabaseReady: Promise<void> | undefined;
}

export function getDb(): HumDatabase {
  if (!globalThis.__humDatabase) {
    const opened = openDatabase();
    globalThis.__humDatabase = opened.database;
    globalThis.__humDatabasePool = opened.pool;
    globalThis.__humDatabaseReady = opened.ready;
  }
  return globalThis.__humDatabase;
}

export async function waitForDatabase(): Promise<void> {
  getDb();
  await globalThis.__humDatabaseReady;
}

export async function closeDatabase(): Promise<void> {
  const pool = globalThis.__humDatabasePool;
  globalThis.__humDatabase = undefined;
  globalThis.__humDatabasePool = undefined;
  globalThis.__humDatabaseReady = undefined;
  if (pool) await pool.end();
}

export async function cleanExpiredSecurityRows(now = Date.now()): Promise<void> {
  const db = getDb();
  await Promise.all([
    await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now),
    await db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now),
    await db.prepare("DELETE FROM upload_grants WHERE expires_at <= ?").run(now),
    await db.prepare("DELETE FROM auth_attempts WHERE window_started <= ? AND blocked_until <= ?").run(now - 24 * 60 * 60 * 1000, now),
  ]);
}
