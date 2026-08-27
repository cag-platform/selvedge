import { describe, expect, it } from 'vitest';
import { applyMigration, createTestDbAt } from '../helpers/testDb.js';

describe('migration 0049 — Simple becomes the presentation default', () => {
  it('moves existing accounts to Simple without changing conversation overrides', async () => {
    const { client, close } = await createTestDbAt('0048');
    try {
      await client.exec(`
        INSERT INTO orgs (org_id, technical_detail) VALUES ('org_1', 'full');
        INSERT INTO subjects (id, org_id, name) VALUES ('ideas', 'org_1', 'Ideas');
        INSERT INTO threads (id, org_id, subject_id, kind, title, agent, technical_detail)
        VALUES ('thread_1', 'org_1', 'ideas', 'general', 'A thought', 'claude', 'full');
      `);

      await applyMigration(client, '0049');

      const accounts = await client.query<{ technical_detail: string }>(`SELECT technical_detail FROM orgs WHERE org_id = 'org_1'`);
      const conversations = await client.query<{ technical_detail: string | null }>(`SELECT technical_detail FROM threads WHERE id = 'thread_1'`);
      expect(accounts.rows[0]?.technical_detail).toBe('simple');
      expect(conversations.rows[0]?.technical_detail).toBe('full');

      await client.exec(`INSERT INTO orgs (org_id) VALUES ('org_2')`);
      const defaults = await client.query<{ technical_detail: string }>(`SELECT technical_detail FROM orgs WHERE org_id = 'org_2'`);
      expect(defaults.rows[0]?.technical_detail).toBe('simple');
    } finally {
      await close();
    }
  });
});
