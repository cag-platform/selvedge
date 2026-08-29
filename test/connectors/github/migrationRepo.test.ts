import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/server/db/client.js';
import { provisionMigrationRepo } from '../../../src/server/connectors/github/migrationRepo.js';

const db = {} as Db;
const files = [{ path: 'index.js', bytes: new TextEncoder().encode('console.log(1)') }];
const installation = { sourceAccountId: '42', meta: 'acme' } as never;

describe('GitHub migration repository provisioning', () => {
  it('refuses before GitHub is changed when the customer has no installation', async () => {
    const request = vi.fn();
    await expect(provisionMigrationRepo(db, 'org_1', 'loom', 'Loom', files, {
      installations: async () => [],
      request,
    })).rejects.toThrow(/Connect the Selvedge GitHub App/);
    expect(request).not.toHaveBeenCalled();
  });

  it('creates and fills the repo with the same short-lived installation credential', async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer short-lived');
      return new Response(JSON.stringify({ full_name: 'acme/loom' }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    const push = vi.fn(async (token: string, fullName: string) => {
      expect(token).toBe('short-lived');
      expect(fullName).toBe('acme/loom');
      return { commitSha: 'abc', branch: 'main', files: 1 };
    });
    const result = await provisionMigrationRepo(db, 'org_1', 'loom', 'Loom', files, {
      installations: async () => [installation],
      mint: async () => 'short-lived',
      request: request as typeof fetch,
      push,
    });
    expect(result).toMatchObject({ fullName: 'acme/loom', pushed: { files: 1 } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('turns missing app permissions into an actionable authorization boundary', async () => {
    await expect(provisionMigrationRepo(db, 'org_1', 'loom', 'Loom', files, {
      installations: async () => [installation],
      mint: async () => 'short-lived',
      request: async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }),
    })).rejects.toThrow(/Administration \(write\).*Contents \(write\)/);
  });
});
