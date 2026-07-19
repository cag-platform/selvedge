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
export async function createTestDb() {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const statements = sql.split('--> statement-breakpoint');
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await client.exec(trimmed);
    }
  }

  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
