import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { goLive, needsDatabase, liveAppLimit, existingHostTarget, type GoLiveDeps } from '../../src/server/build/golive.js';
import { DeployTimeoutError } from '../../src/server/connectors/railway/provision.js';
import { listHealthChecksToPoll } from '../../src/server/monitor/wiring.js';

/** Every network edge stubbed — what's under test is the decision-making. */
function deps(over: Partial<GoLiveDeps> = {}): GoLiveDeps {
  return {
    account: async () => ({ token: 'tok', owner: 'selvedge' }),
    provisionDb: async () => ({ neonProjectId: 'neon_1', connectionUri: 'postgres://u:p@h/db' }),
    hostProject: async () => ({ projectId: 'proj_1', environmentId: 'env_1' }),
    makeService: async () => 'svc_1',
    setVars: async () => undefined,
    domain: async () => 'https://loom-production.up.railway.app',
    awaitDeploy: async () => undefined,
    readFile: async () => null,
    ...over,
  };
}

describe('needsDatabase — the app declares what it needs, in its own .env.example', () => {
  it('sees a DATABASE_URL the agent wrote down', () => {
    expect(needsDatabase('# what it is for\nDATABASE_URL=\nCLERK_SECRET_KEY=')).toBe(true);
    expect(needsDatabase('#DATABASE_URL=postgres://...')).toBe(true);
  });

  it('does not invent one for an app that never asked', () => {
    expect(needsDatabase('CLERK_SECRET_KEY=\nSTRIPE_KEY=')).toBe(false);
    expect(needsDatabase(null)).toBe(false);
    expect(needsDatabase('')).toBe(false);
    // A mention inside prose is not a declaration.
    expect(needsDatabase('# we might add a DATABASE_URL later')).toBe(false);
  });
});

describe('goLive — one button, from a repo to a working address', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const withRepo = (projectId = 'loom') =>
    makeTestPack({
      identity: { project_id: projectId, name: projectId, owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: `acme/${projectId}`, role: 'source_of_truth' }] },
    });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, plan: 'studio' });
    await createPack(db, orgId, withRepo());
  });
  afterEach(async () => close());

  it('creates the service, mints an address, and records it where the watchers already look', async () => {
    const out = await goLive(db, orgId, 'loom', deps());
    expect(out.outcome).toBe('live');
    if (out.outcome !== 'live') return;
    expect(out.url).toBe('https://loom-production.up.railway.app');

    const pack = (await getPack(db, orgId, 'loom'))!;
    // The live address the post-ship watcher and health monitor both read.
    expect(pack.identity.links?.live_url).toBe(out.url);
    // The host source the deploy poller scans for, in its compound form.
    const host = pack.topology.sources.find((s) => s.connector === 'railway');
    expect(host?.resource_id).toBe('proj_1/env_1/svc_1');
    expect(host?.role).toBe('production_host');
    expect(existingHostTarget(pack)).toEqual({ projectId: 'proj_1', environmentId: 'env_1', serviceId: 'svc_1' });
  });

  it('provisions a database only when the app asked for one, and never stores the connection string', async () => {
    let provisioned = 0;
    let sentVars: Record<string, string> = {};
    await goLive(
      db,
      orgId,
      'loom',
      deps({
        readFile: async () => 'DATABASE_URL=\n',
        provisionDb: async () => {
          provisioned += 1;
          return { neonProjectId: 'neon_1', connectionUri: 'postgres://secret@host/db' };
        },
        setVars: async (_t, _target, vars) => void (sentVars = vars),
      }),
    );
    expect(provisioned).toBe(1);
    expect(sentVars.DATABASE_URL).toBe('postgres://secret@host/db');
    expect(sentVars.PORT).toBe('3000'); // the same port the agent's rules bind

    const pack = (await getPack(db, orgId, 'loom'))!;
    expect(pack.topology.sources.some((s) => s.connector === 'neon')).toBe(true);
    // The secret is set on the host and held nowhere here.
    expect(JSON.stringify(pack)).not.toContain('secret@host');
  });

  it('skips the database for an app that never asked for one', async () => {
    let provisioned = 0;
    await goLive(db, orgId, 'loom', deps({ readFile: async () => 'CLERK_SECRET_KEY=\n', provisionDb: async () => { provisioned += 1; return { neonProjectId: 'n', connectionUri: 'c' }; } }));
    expect(provisioned).toBe(0);
  });

  it('a second press reuses the service instead of creating another one', async () => {
    await goLive(db, orgId, 'loom', deps());
    let created = 0;
    const out = await goLive(db, orgId, 'loom', deps({ makeService: async () => { created += 1; return 'svc_2'; } }));
    expect(out.outcome).toBe('already_live');
    expect(created).toBe(0);
  });

  it('a slow first build is honest that it is still coming, and stays correctly wired for the retry', async () => {
    const out = await goLive(db, orgId, 'loom', deps({ awaitDeploy: async () => { throw new DeployTimeoutError('slow'); } }));
    expect(out.outcome).toBe('still_building');
    if (out.outcome !== 'still_building') return;
    expect(out.message).toMatch(/still building/i);
    // Wired despite the timeout — so nothing is orphaned and a retry converges.
    const pack = (await getPack(db, orgId, 'loom'))!;
    expect(pack.identity.links?.live_url).toBe(out.url);
  });

  it('a build that actually failed says so, and never claims an address works', async () => {
    const out = await goLive(db, orgId, 'loom', deps({ awaitDeploy: async () => { throw new Error('the host tried to build it and it failed (failed)'); } }));
    expect(out.outcome).toBe('failed');
    expect(out.message).toMatch(/couldn't finish/i);
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId)).orderBy(agentMessages.createdAt);
    expect(msg).toBeTruthy();
  });

  it('with no hosting of their own, it asks them to connect theirs — and says why that is the good outcome', async () => {
    const out = await goLive(db, orgId, 'loom', deps({ account: async () => null }));
    expect(out.outcome).toBe('not_possible');
    expect(out.message).toMatch(/connect your hosting/i);
    expect(out.message).toMatch(/stays in your name/i);
  });

  it('refuses a project with no code connected', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'bare', name: 'Bare', owner_description: 'x' }, topology: { sources: [] } }));
    const out = await goLive(db, orgId, 'bare', deps());
    expect(out.outcome).toBe('not_possible');
    expect(out.message).toMatch(/no code connected/i);
  });

  /**
   * The gap these cover: go-live wrote the host into topology (which starts the
   * DEPLOY poller) and said "I'm watching it from now on", but nothing ever
   * created a health_checks row — so the probe half of the watch polled an
   * empty table forever. "Recorded" and "watched" were two different things.
   */
  it('arms the health watch on the new address, so the monitor has something to poll', async () => {
    const out = await goLive(db, orgId, 'loom', deps());
    expect(out.outcome).toBe('live');

    const toPoll = await listHealthChecksToPoll(db);
    expect(toPoll).toHaveLength(1);
    expect(toPoll[0]!.spec.url).toBe('https://loom-production.up.railway.app');
    expect(toPoll[0]!.spec.kind).toBe('http');
    expect(toPoll[0]!.projectId).toBe('loom');
    // Resolved to the repo, so a health event lands on the same timeline as the
    // pushes and deploys it will be correlated against.
    expect(toPoll[0]!.sourceAccountId).toBe('acme/loom');
  });

  it('arms the watch even when the first build times out — the message promises exactly that', async () => {
    const out = await goLive(db, orgId, 'loom', deps({ awaitDeploy: async () => { throw new DeployTimeoutError('slow'); } }));
    expect(out.outcome).toBe('still_building');
    if (out.outcome !== 'still_building') return;
    expect(out.message).toMatch(/watching it/i);
    expect(await listHealthChecksToPoll(db)).toHaveLength(1);
  });

  it('going live twice watches the app once, not twice', async () => {
    await goLive(db, orgId, 'loom', deps());
    await goLive(db, orgId, 'loom', deps()); // already_live
    expect(await listHealthChecksToPoll(db)).toHaveLength(1);
  });

  it('a failure to arm the watch does not fail the go-live it already completed', async () => {
    const out = await goLive(db, orgId, 'loom', deps({ watch: async () => { throw new Error('checks table is having a day'); } }));
    // The app IS online; refusing to say so because a follow-up write failed
    // would be its own dishonesty.
    expect(out.outcome).toBe('live');
  });
});

describe("the cost guard — Selvedge's hosting is rationed, the owner's own is not", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, plan: 'trial' }); // limit of 1
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'first', name: 'First', owner_description: 'x', links: { live_url: 'https://first.example' } },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/first', role: 'source_of_truth' }] },
      }),
    );
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'second', name: 'Second', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/second', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  it('caps how many apps Selvedge will host on a plan, and says why in plain words', async () => {
    const out = await goLive(db, orgId, 'second', deps());
    expect(out.outcome).toBe('not_possible');
    expect(out.message).toMatch(/limit on your plan/i);
  });

  it("never rations someone hosting on their own account — it isn't Selvedge's bill", async () => {
    const out = await goLive(db, orgId, 'second', deps({ account: async () => ({ token: 'their-tok', owner: 'customer' }) }));
    expect(out.outcome).toBe('live');
    if (out.outcome !== 'live') return;
    expect(out.message).toMatch(/your own Railway account/i);
  });

  it('reads the limit from the plan, with a safe default for an unknown one', () => {
    expect(liveAppLimit('trial')).toBe(1);
    expect(liveAppLimit('studio')).toBe(10);
    expect(liveAppLimit('nonsense')).toBe(1); // never "unlimited"
    expect(liveAppLimit(undefined)).toBe(1);
  });
});

/**
 * Railway's fair-use policy prohibits reselling compute; Vercel's terms
 * prohibit making the service available to third parties (MIGRATION-CENTER §1).
 * So Selvedge's own account is never a silent fallback for customer apps — the
 * deed stays in the customer's name, which is also the whole pitch.
 */
describe('the hosting account is the customer’s, by construction', () => {
  const OLD = process.env.SELVEDGE_MANAGED_HOSTING;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SELVEDGE_MANAGED_HOSTING;
    else process.env.SELVEDGE_MANAGED_HOSTING = OLD;
  });

  it('never falls back to Selvedge’s own account by default', async () => {
    delete process.env.SELVEDGE_MANAGED_HOSTING;
    process.env.RAILWAY_API_TOKEN = 'platform-token';
    const { resolveHostAccount, managedHostingAllowed } = await import('../../src/server/build/hostAccount.js');
    expect(managedHostingAllowed()).toBe(false);
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_x' });
      expect(await resolveHostAccount(t.db, 'org_x')).toBeNull();
    } finally {
      await t.close();
      delete process.env.RAILWAY_API_TOKEN;
    }
  });

  it('allows Selvedge’s own account only behind the explicit dogfooding flag', async () => {
    process.env.SELVEDGE_MANAGED_HOSTING = '1';
    process.env.RAILWAY_API_TOKEN = 'platform-token';
    const { resolveHostAccount } = await import('../../src/server/build/hostAccount.js');
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_y' });
      expect(await resolveHostAccount(t.db, 'org_y')).toEqual({ token: 'platform-token', owner: 'selvedge' });
    } finally {
      await t.close();
      delete process.env.RAILWAY_API_TOKEN;
    }
  });
});
