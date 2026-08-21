import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { narrations, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { ingestEvent, ingestResolvedEvent } from '../../src/server/resolution/ingest.js';
import { recordSession } from '../../src/server/companion/sessions.js';
import { normalizePush } from '../../src/server/connectors/github/normalizer.js';
import { composeDigestForOrg } from '../../src/server/digest/compose.js';
import { projectTimeline } from '../../src/server/timeline/store.js';
import type { NewSelvedgeEvent } from '../../src/shared/types/event.js';

/**
 * PHASE 4'S GATE, MANUFACTURED.
 *
 * Break a project on purpose from a session Selvedge never ran, and the next
 * morning's brief has to trace it back — unprompted, in plain English. Then
 * manufacture ambiguity and watch it refuse to pick.
 *
 * The whole path is real here: a GitHub push normalised by the connector, the
 * ingest pipeline, the correlation step, the fusion join, the stored narration,
 * and the composed brief. Nothing is stubbed except the passage of time.
 */
describe('the fused sentence, end to end', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const OTHER = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

  // Yesterday, so the brief's window (which reads yesterday) contains it.
  const yesterday = (hour: number) => {
    const d = new Date(Date.now() - 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.', links: { live_url: 'https://loom.example' } },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  /** A real push, through the real normalizer, so change_refs are produced the way production produces them. */
  async function aPushLanded(commits: Array<{ id: string; message: string }>, at: Date) {
    const event = normalizePush(orgId, {
      ref: 'refs/heads/main',
      before: 'before',
      after: commits.at(-1)!.id,
      created: false,
      deleted: false,
      commits,
      head_commit: { id: commits.at(-1)!.id, timestamp: at.toISOString() },
      repository: { full_name: 'acme/loom', default_branch: 'main' } as never,
    })!;
    await ingestEvent(db, { ...event, occurred_at: at.toISOString(), dedupe_key: `push-${commits.at(-1)!.id}` });
  }

  /** The health monitor's own path: it already knows which project stopped answering. */
  async function somethingBroke(at: Date): Promise<void> {
    const brk: NewSelvedgeEvent = {
      org_id: orgId,
      source: 'custom',
      source_account_id: 'acme/loom',
      event_type: 'runtime.health_failing',
      occurred_at: at.toISOString(),
      severity_hint: 'error',
      raw: {},
      dedupe_key: `break-${at.toISOString()}`,
    };
    await ingestResolvedEvent(db, 'loom', brk);
  }

  async function fusionOnTheBreak() {
    const rows = await db
      .select()
      .from(narrations)
      .where(and(eq(narrations.orgId, orgId), eq(narrations.eventType, 'runtime.health_failing')));
    return (rows[0]?.meta as { fusion?: { sentence: string; ambiguous: boolean } } | null)?.fusion ?? null;
  }

  it('traces a break to the terminal session that produced the change — unprompted', async () => {
    // Yesterday morning, in a terminal Selvedge doesn't run: a Codex session,
    // which the companion reported afterwards.
    await recordSession(db, orgId, {
      agent: 'codex',
      session_id: 'cx-guest-checkout',
      outcome: 'shipped',
      repo: 'acme/loom',
      intent: 'let people check out as a guest',
      commit_sha: SHA,
      started_at: yesterday(9).toISOString(),
      ended_at: yesterday(10).toISOString(),
    });

    // The commit lands, and an hour later the app starts failing.
    await aPushLanded([{ id: SHA, message: 'guest checkout' }], yesterday(11));
    await somethingBroke(yesterday(12));

    const fused = await fusionOnTheBreak();
    expect(fused).not.toBeNull();
    expect(fused!.ambiguous).toBe(false);
    expect(fused!.sentence).toMatch(/began after the change from .*Codex session \(let people check out as a guest\)/);
    // A lead, never a verdict.
    expect(fused!.sentence).not.toMatch(/caused|because/i);

    // The brief says it, without anyone asking.
    const digest = await composeDigestForOrg(db, orgId);
    expect(digest.renderedText).toContain('Codex session');
    expect(digest.renderedText).toContain('let people check out as a guest');

    // And so does the project's own history.
    const timeline = await projectTimeline(db, orgId, 'loom');
    const brk = timeline.find((e) => e.kind === 'event' && /began after/.test(e.sentence));
    expect(brk).toBeTruthy();
  });

  it('refuses to pick when two changes could be behind it', async () => {
    // Two sessions, two commits, one push — the ambiguous case the brief says
    // must stay ambiguous.
    await recordSession(db, orgId, {
      agent: 'codex',
      session_id: 'cx-1',
      outcome: 'shipped',
      repo: 'acme/loom',
      intent: 'the guest-checkout work',
      commit_sha: SHA,
      ended_at: yesterday(9).toISOString(),
    });
    await recordSession(db, orgId, {
      agent: 'claude-code',
      session_id: 'cc-1',
      outcome: 'shipped',
      repo: 'acme/loom',
      intent: 'the delivery estimate',
      commit_sha: OTHER,
      ended_at: yesterday(10).toISOString(),
    });

    await aPushLanded(
      [
        { id: SHA, message: 'guest checkout' },
        { id: OTHER, message: 'delivery estimate' },
      ],
      yesterday(11),
    );
    await somethingBroke(yesterday(12));

    const fused = await fusionOnTheBreak();
    expect(fused!.ambiguous).toBe(true);
    expect(fused!.sentence).toMatch(/I can't tell which/);
    expect(fused!.sentence).toContain('Codex session');
    expect(fused!.sentence).toContain('Claude Code session');

    const digest = await composeDigestForOrg(db, orgId);
    expect(digest.renderedText).toMatch(/I can't tell which/);
  });

  it('invents nothing when the change names no session', async () => {
    // Somebody pushed from their own machine with no companion running. The
    // correlation line still appears; the fused sentence does not.
    await aPushLanded([{ id: SHA, message: 'a change from nowhere' }], yesterday(11));
    await somethingBroke(yesterday(12));

    expect(await fusionOnTheBreak()).toBeNull();
    const digest = await composeDigestForOrg(db, orgId);
    expect(digest.renderedText).not.toMatch(/began after the change from/);
  });

  it('invents nothing when nothing changed before the break at all', async () => {
    await somethingBroke(yesterday(12));
    expect(await fusionOnTheBreak()).toBeNull();
  });
});
