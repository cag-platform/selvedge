import { describe, it, expect } from 'vitest';
import { applyMigration, createTestDbAt } from '../helpers/testDb.js';

/**
 * MIGRATION 0022, TESTED AGAINST DATA THAT WAS ALREADY THERE.
 *
 * A backfill applied to an empty database is the one case where it cannot be
 * wrong. So this builds the database as it stood at 0021, fills it with the
 * shape a real project had then — a workshop conversation, its runs, its build
 * state — and only then applies threads.
 *
 * What must survive: every existing message and run keeps its place in the
 * conversation it belongs to, in a product whose entire premise is that the
 * record is the thing being sold.
 */
describe('migration 0022 — the existing conversation becomes thread #1', () => {
  async function legacyDb() {
    const t = await createTestDbAt('0021');
    await t.client.exec(`INSERT INTO orgs (org_id) VALUES ('org_1'), ('org_2')`);
    return t;
  }

  it('gives each project one thread, attaches its whole history, and dates it by its oldest message', async () => {
    const { client, close } = await legacyDb();
    try {
      await client.exec(`
        INSERT INTO project_build (org_id, project_id, sandbox_id, agent_model) VALUES ('org_1', 'loom', 'sbx_1', 'opus');
        INSERT INTO agent_messages (id, org_id, project_id, role, content, created_at) VALUES
          ('m1', 'org_1', 'loom', 'owner', 'make the header dark', '2026-03-02T09:00:00Z'),
          ('m2', 'org_1', 'loom', 'agent', 'Done.', '2026-03-02T09:04:00Z'),
          ('m3', 'org_1', 'loom', 'owner', 'now the footer', '2026-05-11T14:00:00Z');
        INSERT INTO agent_runs (id, org_id, project_id, prompt, status, created_at) VALUES
          ('r1', 'org_1', 'loom', 'make the header dark', 'succeeded', '2026-03-02T09:00:00Z');
      `);

      await applyMigration(client, '0022');

      const threads = await client.query<{ id: string; kind: string; title: string; agent: string; model: string; created_at: Date }>(
        `SELECT id, kind, title, agent, model, created_at FROM threads`,
      );
      expect(threads.rows).toHaveLength(1);
      const thread = threads.rows[0]!;
      expect(thread.kind).toBe('workshop');
      expect(thread.title).toBe('Workshop');
      expect(thread.agent).toBe('claude-code');
      // The model the project was actually running under, not a fresh default.
      expect(thread.model).toBe('opus');
      // Its birthday is the oldest thing it holds, so the rail's dates read
      // true rather than all saying "today, at deploy time".
      expect(new Date(thread.created_at).toISOString()).toBe('2026-03-02T09:00:00.000Z');

      const messages = await client.query<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM agent_messages ORDER BY id`);
      expect(messages.rows.map((r) => r.thread_id)).toEqual([thread.id, thread.id, thread.id]);
      const runs = await client.query<{ thread_id: string }>(`SELECT thread_id FROM agent_runs`);
      expect(runs.rows[0]!.thread_id).toBe(thread.id);
    } finally {
      await close();
    }
  });

  it('never merges two orgs that happen to share a project name', async () => {
    const { client, close } = await legacyDb();
    try {
      await client.exec(`
        INSERT INTO agent_messages (id, org_id, project_id, role, content) VALUES
          ('a1', 'org_1', 'loom', 'owner', 'ours'),
          ('b1', 'org_2', 'loom', 'owner', 'theirs');
      `);
      await applyMigration(client, '0022');

      const rows = await client.query<{ org_id: string; id: string }>(`SELECT org_id, id FROM threads ORDER BY org_id`);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]!.id).not.toBe(rows.rows[1]!.id);

      const mine = await client.query<{ thread_id: string }>(`SELECT thread_id FROM agent_messages WHERE id = 'a1'`);
      expect(mine.rows[0]!.thread_id).toBe(rows.rows[0]!.id);
    } finally {
      await close();
    }
  });

  it('covers a project that has a sandbox but has never been talked to', async () => {
    const { client, close } = await legacyDb();
    try {
      await client.exec(`INSERT INTO project_build (org_id, project_id) VALUES ('org_1', 'quiet')`);
      await applyMigration(client, '0022');
      const rows = await client.query<{ project_id: string; model: string }>(`SELECT project_id, model FROM threads`);
      expect(rows.rows.map((r) => r.project_id)).toEqual(['quiet']);
      expect(rows.rows[0]!.model).toBe('sonnet'); // the column's own default, carried across
    } finally {
      await close();
    }
  });

  it('re-runs without changing anything — a half-applied deploy can be finished, not feared', async () => {
    const { client, close } = await legacyDb();
    try {
      await client.exec(`INSERT INTO agent_messages (id, org_id, project_id, role, content) VALUES ('m1', 'org_1', 'loom', 'owner', 'hello')`);
      await applyMigration(client, '0022');
      const before = await client.query<{ id: string; created_at: Date }>(`SELECT id, created_at FROM threads`);

      await applyMigration(client, '0022');

      const after = await client.query<{ id: string; created_at: Date }>(`SELECT id, created_at FROM threads`);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
      expect(new Date(after.rows[0]!.created_at).toISOString()).toBe(new Date(before.rows[0]!.created_at).toISOString());
    } finally {
      await close();
    }
  });

  it('does nothing at all to a database that has never had a workshop', async () => {
    const { client, close } = await legacyDb();
    try {
      await applyMigration(client, '0022');
      const rows = await client.query(`SELECT id FROM threads`);
      expect(rows.rows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
