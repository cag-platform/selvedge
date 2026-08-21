import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentRuns, events, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { recordSession } from '../../src/server/companion/sessions.js';
import { attributionsFor, changeRefsFor, fusionForChange } from '../../src/server/fusion/resolve.js';
import { stampedCommitMessage, parseSessionTrailer } from '../../src/server/provenance/trailer.js';
import { normalizePush } from '../../src/server/connectors/github/normalizer.js';

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OTHER_SHA = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';
const BREAK_AT = new Date('2026-08-20T14:00:00Z');

describe('resolving a change to the work behind it', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  /** A change event as the connector would have written it. */
  async function changeEvent(refs: { commits: string[]; sessions: string[] }): Promise<string> {
    const id = ulid();
    await db.insert(events).values({
      id,
      orgId,
      source: 'github',
      sourceAccountId: 'acme/loom',
      projectId: 'loom',
      eventType: 'code.commits_landed_default',
      occurredAt: new Date('2026-08-20T13:00:00Z'),
      severityHint: 'info',
      raw: {},
      changeRefs: refs,
      dedupeKey: `dedupe-${id}`,
    });
    return id;
  }

  it('follows the trailer: the commit says which conversation asked for it', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    const eventId = await changeEvent({ commits: [SHA], sessions: [thread.id] });

    const fused = await fusionForChange(db, orgId, eventId, BREAK_AT);
    expect(fused?.ambiguous).toBe(false);
    expect(fused?.sentence).toContain('Checkout rework');
    expect(fused?.attributions[0]).toMatchObject({ kind: 'selvedge', threadId: thread.id });
  });

  it('follows the run row when the message was rewritten and the trailer is gone', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Guest checkout' });
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'ship: guest checkout',
      status: 'succeeded',
      commitSha: SHA,
    });
    const eventId = await changeEvent({ commits: [SHA], sessions: [] });

    const fused = await fusionForChange(db, orgId, eventId, BREAK_AT);
    expect(fused?.sentence).toContain('Guest checkout');
  });

  it('follows the companion: a terminal session that had this commit land while it was open', async () => {
    await recordSession(db, orgId, {
      agent: 'codex',
      session_id: 'cx-1',
      outcome: 'shipped',
      repo: 'acme/loom',
      intent: 'the guest-checkout work',
      commit_sha: SHA,
      ended_at: '2026-08-17T11:00:00Z',
    });
    const eventId = await changeEvent({ commits: [SHA], sessions: [] });

    const fused = await fusionForChange(db, orgId, eventId, BREAK_AT);
    expect(fused?.sentence).toBe("This began after the change from Monday's Codex session (the guest-checkout work).");
    expect(fused?.attributions[0]).toMatchObject({ kind: 'observed', agent: 'codex' });
  });

  it('counts one session once, however many roads lead to it', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'ship: checkout',
      status: 'succeeded',
      commitSha: SHA,
    });
    // Both the trailer and the run row point at the same thread.
    const eventId = await changeEvent({ commits: [SHA], sessions: [thread.id] });

    const fused = await fusionForChange(db, orgId, eventId, BREAK_AT);
    expect(fused?.attributions).toHaveLength(1);
    expect(fused?.ambiguous).toBe(false);
    // The commit is recorded on it, so the reader can go and look.
    expect(fused?.attributions[0]?.commit).toBe(SHA);
  });

  it('names both when two sessions are in the same change, and picks neither', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    await recordSession(db, orgId, {
      agent: 'codex',
      session_id: 'cx-2',
      outcome: 'shipped',
      repo: 'acme/loom',
      intent: 'the delivery estimate',
      commit_sha: OTHER_SHA,
      ended_at: '2026-08-19T11:00:00Z',
    });
    const eventId = await changeEvent({ commits: [SHA, OTHER_SHA], sessions: [thread.id] });

    const fused = await fusionForChange(db, orgId, eventId, BREAK_AT);
    expect(fused?.ambiguous).toBe(true);
    expect(fused?.sentence).toMatch(/I can't tell which/);
  });

  it('says nothing when the commits name nobody', async () => {
    const eventId = await changeEvent({ commits: [SHA], sessions: [] });
    expect(await fusionForChange(db, orgId, eventId, BREAK_AT)).toBeNull();
  });

  it('says nothing when the change carried no commits at all', async () => {
    const eventId = await changeEvent({ commits: [], sessions: [] });
    expect(await changeRefsFor(db, orgId, eventId)).toBeNull();
    expect(await fusionForChange(db, orgId, eventId, BREAK_AT)).toBeNull();
  });

  it('is org-scoped: another org\'s thread is never the answer', async () => {
    const thread = await createThread(db, 'org_2', 'loom', { kind: 'workshop', title: 'Their work' });
    const eventId = await changeEvent({ commits: [SHA], sessions: [thread.id] });
    expect(await attributionsFor(db, orgId, { commits: [SHA], sessions: [thread.id] })).toEqual([]);
    expect(await fusionForChange(db, orgId, eventId, BREAK_AT)).toBeNull();
  });

  it('the connector extracts what fusion needs, and never asks anyone downstream to read raw', () => {
    // The road the trailer actually travels: ship stamps the commit, GitHub
    // sends the message, the normalizer lifts the session id onto the envelope.
    const message = stampedCommitMessage('Selvedge: guest checkout', '01J8Z5M9QK7T2R4N6P0V3W1XYZ');
    expect(parseSessionTrailer(message)).toBe('01J8Z5M9QK7T2R4N6P0V3W1XYZ');

    const event = normalizePush(orgId, {
      ref: 'refs/heads/main',
      before: 'x',
      after: SHA,
      created: false,
      deleted: false,
      commits: [{ id: SHA, message }],
      head_commit: { id: SHA, timestamp: '2026-08-20T13:00:00Z' },
      repository: { full_name: 'acme/loom', default_branch: 'main' } as never,
    })!;
    expect(event.change_refs).toEqual({ commits: [SHA], sessions: ['01J8Z5M9QK7T2R4N6P0V3W1XYZ'] });
  });
});
