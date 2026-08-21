import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/server/db/schema/index.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/server/db/migrations');

/**
 * Spins up an in-memory Postgres-compatible DB (PGlite, real Postgres
 * compiled to WASM) and applies the same SQL migrations the production
 * (Neon) database gets. This is what integration tests run against — no
 * network, no external Postgres required, real SQL semantics (JSONB,
 * partitioning, unique constraints).
 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Apply one migration file, statement by statement, exactly as the migrator does. */
export async function applyMigration(client: PGlite, tag: string): Promise<void> {
  const file = migrationFiles().find((f) => f.startsWith(tag));
  if (!file) throw new Error(`no migration file starting with ${tag}`);
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length === 0) continue;
    await client.exec(trimmed);
  }
}

async function build(upToTag: string | null) {
  const client = new PGlite();
  for (const file of migrationFiles()) {
    await applyMigration(client, file.replace(/\.sql$/, ''));
    if (upToTag && file.startsWith(upToTag)) break;
  }
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

export async function createTestDb() {
  return build(null);
}

/**
 * The database as it stood at an earlier migration — for testing what a
 * migration does to data that is already there. Without this, a backfill is
 * only ever exercised against an empty database, which is the one case where
 * it cannot be wrong.
 */
export async function createTestDbAt(tag: string) {
  return build(tag);
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
