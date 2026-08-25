import { describe, expect, it } from 'vitest';
import { applyMigration, createTestDbAt } from '../helpers/testDb.js';

describe('migration 0036 — technical detail is presentation state, not lost history', () => {
  it('backfills existing accounts to Full and leaves conversation overrides inheriting', async () => {
    const { client, close } = await createTestDbAt('0035');
    try {
      await client.exec(`
        INSERT INTO orgs (org_id) VALUES ('org_1');
        INSERT INTO subjects (id, org_id, name) VALUES ('ideas', 'org_1', 'Ideas');
        INSERT INTO threads (id, org_id, subject_id, kind, title, agent)
        VALUES ('thread_1', 'org_1', 'ideas', 'general', 'A thought', 'claude');
      `);

      await applyMigration(client, '0036');

      const accounts = await client.query<{ technical_detail: string }>(`SELECT technical_detail FROM orgs WHERE org_id = 'org_1'`);
      const conversations = await client.query<{ technical_detail: string | null }>(`SELECT technical_detail FROM threads WHERE id = 'thread_1'`);
      expect(accounts.rows[0]?.technical_detail).toBe('full');
      expect(conversations.rows[0]?.technical_detail).toBeNull();
    } finally {
      await close();
    }
  });
});
