import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNewRepo, GithubError } from '../../../src/server/connectors/github/newRepo.js';

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('createNewRepo — start-from-nothing repos, readable failures', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GITHUB_ORG;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ORG;
  });

  it('creates a private, README-initialized repo under the org when GITHUB_ORG is set', async () => {
    process.env.GITHUB_ORG = 'cag-platform';
    const fetchMock = respond(201, { full_name: 'cag-platform/loom', html_url: 'https://github.com/cag-platform/loom' });
    vi.stubGlobal('fetch', fetchMock);

    const repo = await createNewRepo('loom', 'Loom — created by Selvedge');
    expect(repo.fullName).toBe('cag-platform/loom');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/orgs/cag-platform/repos');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ name: 'loom', private: true, auto_init: true });
  });

  it('falls back to the token user account when GITHUB_ORG is unset', async () => {
    const fetchMock = respond(201, { full_name: 'greg/loom', html_url: 'https://github.com/greg/loom' });
    vi.stubGlobal('fetch', fetchMock);
    await createNewRepo('loom', 'x');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.github.com/user/repos');
  });

  it('maps GitHub failures to readable errors without echoing the token', async () => {
    vi.stubGlobal('fetch', respond(422, { errors: [{ message: 'name already exists on this account' }] }));
    await expect(createNewRepo('loom', 'x')).rejects.toMatchObject({ alreadyExists: true });

    vi.stubGlobal('fetch', respond(401, { message: 'Bad credentials' }));
    await expect(createNewRepo('loom', 'x')).rejects.toThrow(/bad or expired/);

    vi.stubGlobal('fetch', respond(404, { message: 'Not Found' }));
    const err = await createNewRepo('loom', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(String((err as Error).message)).not.toContain('test-token');
  });
});
