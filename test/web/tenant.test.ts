import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@clerk/express', () => ({ getAuth: vi.fn() }));
import { getAuth } from '@clerk/express';
import { tenantOf } from '../../src/server/web/middleware/tenant.js';
import { ensureOrg } from '../../src/server/web/middleware/ensureOrg.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { eq } from 'drizzle-orm';

const auth = (v: { orgId: string | null; userId: string | null }) => (getAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

describe('tenantOf — org when there is one, else the user, never a required org', () => {
  it('prefers the active org (a team)', () => {
    auth({ orgId: 'org_team', userId: 'user_greg' });
    expect(tenantOf({} as Request)).toBe('org_team');
  });

  it('falls back to the signed-in user (the solo owner) when there is no org', () => {
    auth({ orgId: null, userId: 'user_greg' });
    expect(tenantOf({} as Request)).toBe('user_greg');
  });

  it('is null only when not signed in at all', () => {
    auth({ orgId: null, userId: null });
    expect(tenantOf({} as Request)).toBeNull();
  });
});

describe('ensureOrg — a solo owner with no org is no longer locked out', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
  });
  afterEach(async () => close());

  function runMiddleware(): Promise<{ status: number | null; orgId: string | null }> {
    return new Promise((resolve) => {
      const req = {} as Request & { orgId?: string };
      let status: number | null = null;
      const res = {
        status(code: number) {
          status = code;
          return { json: () => resolve({ status, orgId: null }) };
        },
      } as unknown as Response;
      const next = () => resolve({ status, orgId: req.orgId ?? null });
      void ensureOrg(db)(req, res, next);
    });
  }

  it('admits a solo owner scoped to their own user id, and records the tenant', async () => {
    auth({ orgId: null, userId: 'user_greg' });
    const out = await runMiddleware();
    expect(out.status).toBeNull(); // not a 401
    expect(out.orgId).toBe('user_greg');
    const [row] = await db.select().from(orgs).where(eq(orgs.orgId, 'user_greg'));
    expect(row?.orgId).toBe('user_greg');
  });

  it('scopes a team to its org id', async () => {
    auth({ orgId: 'org_team', userId: 'user_greg' });
    expect((await runMiddleware()).orgId).toBe('org_team');
  });

  it('401s only when there is no session', async () => {
    auth({ orgId: null, userId: null });
    expect((await runMiddleware()).status).toBe(401);
  });
});
