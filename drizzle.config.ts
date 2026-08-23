import { defineConfig } from 'drizzle-kit';

/**
 * READ THIS BEFORE RUNNING `npm run db:generate`.
 *
 * The `schema` list below is NOT the schema — it stopped tracking it long ago,
 * and most tables in `src/server/db/schema/` are missing from it. Migrations
 * here are hand-written: a generated one would compare today's code against a
 * stale snapshot and emit a file that re-adds columns that already exist while
 * silently omitting every table this list has never heard of.
 *
 * So: write the `.sql` by hand in `src/server/db/migrations/`, add its tag to
 * `meta/_journal.json`, and let the test database (which applies the folder
 * file by file) prove it runs. Do not trust drizzle-kit's output here without
 * reading every line of it.
 */
export default defineConfig({
  schema: [
    './src/server/db/schema/orgs.ts',
    './src/server/db/schema/events.ts',
    './src/server/db/schema/packs.ts',
    './src/server/db/schema/connectorHealth.ts',
    './src/server/db/schema/devices.ts',
    './src/server/db/schema/narrations.ts',
    './src/server/db/schema/digests.ts',
    './src/server/db/schema/llmUsage.ts',
    './src/server/db/schema/narrationLibrary.ts',
    './src/server/db/schema/feedback.ts',
    './src/server/db/schema/trustIncidents.ts',
  ],
  out: './src/server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://placeholder',
  },
});
