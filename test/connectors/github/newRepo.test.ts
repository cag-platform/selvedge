import { describe, it, expect, vi } from 'vitest';
import { createRepoWithInstallationToken, GithubError } from '../../../src/server/connectors/github/newRepo.js';

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('customer installation repo creation — readable failures', () => {
  it('creates a private, README-initialized repo in the connected owner account', async () => {
    const fetchMock = respond(201, { full_name: 'cag-platform/loom', html_url: 'https://github.com/cag-platform/loom' });
    const repo = await createRepoWithInstallationToken('cag-platform', 'short-lived-token', 'loom', 'Loom — created by Selvedge', fetchMock);
    expect(repo.fullName).toBe('cag-platform/loom');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/orgs/cag-platform/repos');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ name: 'loom', private: true, auto_init: true });
  });

  it('maps GitHub failures to readable errors without echoing the token', async () => {
    await expect(createRepoWithInstallationToken('cag-platform', 'short-lived-token', 'loom', 'x', respond(422, { errors: [{ message: 'name already exists on this account' }] }))).rejects.toMatchObject({ alreadyExists: true });

    await expect(createRepoWithInstallationToken('cag-platform', 'short-lived-token', 'loom', 'x', respond(401, { message: 'Bad credentials' }))).rejects.toThrow(/installation credential/);

    const err = await createRepoWithInstallationToken('cag-platform', 'short-lived-token', 'loom', 'x', respond(404, { message: 'Not Found' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(String((err as Error).message)).not.toContain('short-lived-token');
  });
});
