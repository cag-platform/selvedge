import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { events, orgs } from '../src/server/db/schema/index.js';
import { ensureCurrentPartitions } from '../src/server/db/partitions.js';

describe('db smoke test', () => {
  it('applies migrations (incl. partitioned events table) and round-trips a row', async () => {
    const { db, client, close } = await createTestDb();
    try {
      await ensureCurrentPartitions(db);

      await db.insert(orgs).values({ orgId: 'org_test' });

      const now = new Date();
      await db.insert(events).values({
        id: '01J000000000000000000TEST',
        orgId: 'org_test',
        source: 'github',
        sourceAccountId: 'cag-platform/loom',
        eventType: 'code.pr_opened',
        occurredAt: now,
        severityHint: 'info',
        raw: { hello: 'world' },
        dedupeKey: 'dedupe-1',
      });

      const rows = await db.select().from(events);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBe('org_test');

      // Duplicate dedupe_key + occurred_at should violate the unique index.
      await expect(
        db.insert(events).values({
          id: '01J000000000000000000TES2',
          orgId: 'org_test',
          source: 'github',
          sourceAccountId: 'cag-platform/loom',
          eventType: 'code.pr_opened',
          occurredAt: now,
          severityHint: 'info',
          raw: {},
          dedupeKey: 'dedupe-1',
        }),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
