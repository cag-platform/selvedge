import { describe, it, expect } from 'vitest';
import { borrowCreateReturn, type GithubOAuthOps } from '../../../src/server/connectors/github/repoSetup.js';

/** A configurable fake of the GitHub OAuth ops, recording what was called. */
function makeOps(over: Partial<GithubOAuthOps> & { revokeCalls?: string[] } = {}): GithubOAuthOps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exchangeCodeForToken: over.exchangeCodeForToken
      ? over.exchangeCodeForToken
      : async () => {
          calls.push('exchange');
          return 'ghu_broad_token';
        },
    createUserRepo: over.createUserRepo
      ? over.createUserRepo
      : async () => {
          calls.push('create');
          return { fullName: 'alice/my-app', htmlUrl: 'https://github.com/alice/my-app' };
        },
    revokeGrant: over.revokeGrant
      ? over.revokeGrant
      : async () => {
          calls.push('revoke');
        },
  };
}

const FIXED = () => new Date('2026-07-31T12:00:00Z');

describe('github/borrowCreateReturn — the key is always returned', () => {
  it('happy path: borrow, build the one door, return the key — in that order', async () => {
    const ops = makeOps();
    const receipt = await borrowCreateReturn(ops, 'oauth-code', 'my-app', FIXED);

    expect(ops.calls).toEqual(['exchange', 'create', 'revoke']);
    expect(receipt.ok).toBe(true);
    expect(receipt.keyReturned).toBe(true);
    expect(receipt.repo?.fullName).toBe('alice/my-app');
    expect(receipt.acts.map((a) => a.act)).toEqual(['key_borrowed', 'door_built', 'key_returned']);
  });

  it('THE GUARANTEE: revokes the key even when repo creation throws', async () => {
    const ops = makeOps({
      createUserRepo: async () => {
        throw new Error('GitHub 422: name already exists');
      },
    });
    const receipt = await borrowCreateReturn(ops, 'oauth-code', 'my-app', FIXED);

    // The broad token was handed back despite the failure — no dangling access.
    expect(ops.calls).toContain('revoke');
    expect(receipt.keyReturned).toBe(true);
    expect(receipt.ok).toBe(false);
    expect(receipt.repo).toBeUndefined();
    expect(receipt.acts.map((a) => a.act)).toEqual(['key_borrowed', 'door_build_failed', 'key_returned']);
    expect(receipt.error).toMatch(/new home/i);
  });

  it('tells the customer to revoke manually when auto-revoke fails after a successful build', async () => {
    const ops = makeOps({
      revokeGrant: async () => {
        throw new Error('network');
      },
    });
    const receipt = await borrowCreateReturn(ops, 'oauth-code', 'my-app', FIXED);

    // The repo exists, but we could not return the key — say so, don't pretend.
    expect(receipt.ok).toBe(false);
    expect(receipt.keyReturned).toBe(false);
    expect(receipt.repo?.fullName).toBe('alice/my-app');
    expect(receipt.acts.map((a) => a.act)).toEqual(['key_borrowed', 'door_built', 'key_return_failed']);
    expect(receipt.error).toMatch(/remove Selvedge from your GitHub authorized apps/i);
  });

  it('stops cleanly when the key was never granted (token exchange fails)', async () => {
    const ops = makeOps({
      exchangeCodeForToken: async () => {
        throw new Error('bad code');
      },
    });
    const receipt = await borrowCreateReturn(ops, 'bad-code', 'my-app', FIXED);

    // Nothing to revoke — no grant was ever held. No create, no revoke.
    expect(ops.calls).toEqual([]);
    expect(receipt.ok).toBe(false);
    expect(receipt.keyReturned).toBe(false);
    expect(receipt.acts).toHaveLength(0);
    expect(receipt.error).toMatch(/nothing was changed/i);
  });

  it('never throws — every failure comes back as a receipt', async () => {
    const ops = makeOps({
      createUserRepo: async () => {
        throw new Error('boom');
      },
      revokeGrant: async () => {
        throw new Error('boom too');
      },
    });
    // Both steps fail; the call still resolves to a receipt rather than throwing.
    const receipt = await borrowCreateReturn(ops, 'oauth-code', 'my-app', FIXED);
    expect(receipt.ok).toBe(false);
    expect(receipt.keyReturned).toBe(false);
    expect(receipt.acts.map((a) => a.act)).toEqual(['key_borrowed', 'door_build_failed', 'key_return_failed']);
  });

  it('stamps every act with a timestamp for the ledger', async () => {
    const receipt = await borrowCreateReturn(makeOps(), 'oauth-code', 'my-app', FIXED);
    for (const act of receipt.acts) {
      expect(act.at).toEqual(new Date('2026-07-31T12:00:00Z'));
    }
  });
});
