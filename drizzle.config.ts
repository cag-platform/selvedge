import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/server/db/schema/orgs.ts',
    './src/server/db/schema/events.ts',
    './src/server/db/schema/packs.ts',
    './src/server/db/schema/connectorHealth.ts',
    './src/server/db/schema/narrations.ts',
    './src/server/db/schema/digests.ts',
    './src/server/db/schema/llmUsage.ts',
    './src/server/db/schema/narrationLibrary.ts',
    './src/server/db/schema/feedback.ts',
  ],
  out: './src/server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://placeholder',
  },
});
