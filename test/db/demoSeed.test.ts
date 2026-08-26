import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import type { Db } from '../../src/server/db/client.js';
import { agentMessages, cards, orgs, packs, threads } from '../../src/server/db/schema/index.js';
import { assertDemoTenantEmpty, DEMO_PROJECT_IDS, seedDemoWorkspace } from '../../src/server/db/demoData.js';
import { deriveProjectStatus } from '../../src/server/packs/healthLine.js';
import { getPack } from '../../src/server/packs/store.js';
import { projectMemory, stackMemory } from '../../src/server/memory/learned.js';
import { contextForProject } from '../../src/server/companion/context.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';

const now = new Date('2026-08-25T18:00:00.000Z');

describe('marketing demo seed', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
  });
  afterEach(async () => close());

  it('builds one coherent five-project workspace for both clients', async () => {
    const result = await seedDemoWorkspace(db as unknown as Db, 'user_demo_marketing', now);

    expect(result).toMatchObject({ projects: 5, threads: 7, messages: 24, openFixes: 2 });
    const projectRows = await db.select().from(packs).where(eq(packs.orgId, 'user_demo_marketing'));
    expect(projectRows.map((row) => row.projectId).sort()).toEqual([...DEMO_PROJECT_IDS].sort());

    const morrow = await getPack(db as unknown as Db, 'user_demo_marketing', 'demo-morrow');
    const relay = await getPack(db as unknown as Db, 'user_demo_marketing', 'demo-relay');
    expect(deriveProjectStatus(morrow!)).toBe('needs');
    expect(deriveProjectStatus(relay!)).toBe('working');

    const open = await db
      .select()
      .from(cards)
      .where(and(eq(cards.orgId, 'user_demo_marketing'), eq(cards.state, 'proposed')));
    expect(open.map((row) => row.title)).toEqual([
      'Ship the booking timezone fallback',
      'Restore the old health-check address',
    ]);

    const conversations = await db.select().from(threads).where(eq(threads.orgId, 'user_demo_marketing'));
    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'user_demo_marketing'));
    expect(conversations).toHaveLength(7);
    expect(messages).toHaveLength(24);

    const parcelThread = conversations.find((thread) => thread.projectId === 'demo-parcel');
    const parcelSwitch = messages.find((message) => message.threadId === parcelThread?.id && message.role === 'switch');
    expect(parcelSwitch).toMatchObject({
      content: '⇄ continued with Codex — handoff 418 tokens, about $0.001',
      meta: {
        switch: {
          from: 'claude-code',
          to: 'codex',
          tokens: 418,
          cost_usd: 0.001,
          payload: null,
          pending: false,
        },
      },
    });

    const consultationThread = conversations.find((thread) => thread.id.endsWith('demo-thread-juniper-card-direction'));
    expect(consultationThread).toMatchObject({
      projectId: 'demo-juniper',
      kind: 'general',
      title: 'Choose the collection-card direction',
    });
    const consultationMessages = messages.filter((message) => message.threadId === consultationThread?.id);
    const consultationMarkers = messages.filter(
      (message) => message.role === 'switch' && (message.meta as { consultation?: unknown } | null)?.consultation,
    );
    expect(consultationMarkers).toHaveLength(1);
    const prompt = consultationMessages.find((message) => message.id.endsWith('demo-message-juniper-design-owner'))!;
    const consultationId = (prompt.meta as { consultation_id: string }).consultation_id;
    expect(consultationMarkers[0]).toMatchObject({
      meta: {
        consulted: ['claude-code', 'codex'],
        consultation_id: consultationId,
        consultation: {
          id: consultationId,
          prompt_id: prompt.id,
          agents: ['claude-code', 'codex'],
        },
      },
    });
    const opinions = consultationMessages.filter((message) => message.role === 'agent');
    expect(opinions).toHaveLength(2);
    expect(opinions.map((message) => (message.meta as { answered_by: string }).answered_by)).toEqual(['claude-code', 'codex']);
    expect(opinions.every((message) => {
      const meta = message.meta as { consultation_id: string; in_reply_to: string };
      return meta.consultation_id === consultationId && meta.in_reply_to === prompt.id;
    })).toBe(true);
    expect(consultationMessages.find((message) => message.id.endsWith('demo-message-juniper-design-decision'))?.content)
      .toContain('image-led rhythm');
  });

  it('surfaces learned memory, governing context and open fixes from real tables', async () => {
    await seedDemoWorkspace(db as unknown as Db, 'user_demo_marketing', now);

    const stack = await stackMemory(db as unknown as Db, 'user_demo_marketing', now);
    expect(stack).toMatchObject({ apps: 5, watched_days: 94, things_learned: 17 });

    const memory = await projectMemory(db as unknown as Db, 'user_demo_marketing', 'demo-morrow', now);
    expect(memory?.learned_signatures[0]?.plain).toContain('Morrow calendar-provider timeouts');
    expect(memory?.glossary).toContainEqual({ term: 'appointment', means: 'booking' });

    const context = await contextForProject(db as unknown as Db, 'user_demo_marketing', 'demo-morrow');
    expect(context?.sections.about[0]).toContain('never guess UTC');
    expect(context?.sections.open.join(' ')).toContain('Ship the booking timezone fallback');
    expect(context?.sections.open.join(' ')).toContain('new bookings');
  });

  it('refreshes timestamps without duplicating the scene', async () => {
    await seedDemoWorkspace(db as unknown as Db, 'user_demo_marketing', now);
    await db.insert(threads).values({
      id: 'user_demo_marketing:rehearsal-thread',
      orgId: 'user_demo_marketing',
      projectId: 'demo-morrow',
      subjectId: null,
      kind: 'general',
      title: 'A rehearsal that should be cleared',
      agent: 'gpt',
      model: null,
      technicalDetail: null,
      createdAt: now,
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    });
    await db.insert(agentMessages).values({
      id: 'user_demo_marketing:rehearsal-message',
      orgId: 'user_demo_marketing',
      projectId: 'demo-morrow',
      threadId: 'user_demo_marketing:rehearsal-thread',
      role: 'owner',
      content: 'This should not survive a demo refresh.',
      meta: null,
      runId: null,
      createdAt: now,
    });
    await seedDemoWorkspace(db as unknown as Db, 'user_demo_marketing', new Date(now.getTime() + 3_600_000));

    expect(await db.select().from(packs).where(eq(packs.orgId, 'user_demo_marketing'))).toHaveLength(5);
    expect(await db.select().from(threads).where(eq(threads.orgId, 'user_demo_marketing'))).toHaveLength(7);
    expect(await db.select().from(cards).where(eq(cards.orgId, 'user_demo_marketing'))).toHaveLength(5);
    expect(await db.select().from(agentMessages).where(eq(agentMessages.orgId, 'user_demo_marketing'))).toHaveLength(24);
  });

  it('namespaces rows so an organization seed cannot touch the old user-scoped scene', async () => {
    await seedDemoWorkspace(db as unknown as Db, 'user_demo_one', now);
    await seedDemoWorkspace(db as unknown as Db, 'org_demo_two', now, { boughtByUserId: 'user_demo_two' });

    const one = await db.select().from(threads).where(eq(threads.orgId, 'user_demo_one'));
    const two = await db.select().from(threads).where(eq(threads.orgId, 'org_demo_two'));
    expect(one).toHaveLength(7);
    expect(two).toHaveLength(7);
    expect(new Set([...one, ...two].map((row) => row.id)).size).toBe(14);
    expect(one.every((row) => row.id.startsWith('user_demo_one:'))).toBe(true);
    expect(two.every((row) => row.id.startsWith('org_demo_two:'))).toBe(true);
  });

  it('refuses to mix marketing data into a real account', async () => {
    await createPack(
      db as unknown as Db,
      'user_real_owner',
      makeTestPack({ identity: { project_id: 'owner-project', name: 'Owner project', owner_description: 'real work' } }),
    );

    await expect(seedDemoWorkspace(db as unknown as Db, 'user_real_owner', now)).rejects.toThrow(/non-demo projects/);
    expect(await db.select().from(packs).where(eq(packs.orgId, 'user_real_owner'))).toHaveLength(1);
  });

  it('allows the empty Clerk org shell but refuses to adopt any tenant containing product data', async () => {
    await db.insert(orgs).values({ orgId: 'org_empty_demo' });
    await expect(assertDemoTenantEmpty(db as unknown as Db, 'org_empty_demo')).resolves.toBeUndefined();

    await createPack(
      db as unknown as Db,
      'org_occupied_demo',
      makeTestPack({ identity: { project_id: 'owner-project', name: 'Owner project', owner_description: 'real work' } }),
    );
    await expect(assertDemoTenantEmpty(db as unknown as Db, 'org_occupied_demo')).rejects.toThrow(/already contains Selvedge data/);
  });

  it('requires a real Clerk tenant namespace', async () => {
    await expect(seedDemoWorkspace(db as unknown as Db, 'tenant_demo', now)).rejects.toThrow(/user_… or org_…/);
  });
});
