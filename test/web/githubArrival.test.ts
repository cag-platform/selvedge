import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGithubArrivalRouter } from '../../src/server/web/routes/githubArrival.js';
import { PersonalGithubError } from '../../src/server/connectors/github/personal.js';

/**
 * The arrival endpoint's three answers, kept distinct: "not a GitHub sign-in"
 * is a normal 200, "GitHub wouldn't answer" is a 502, and the two must never
 * collapse into each other — a client shown `connected: false` during an
 * outage would hide the card from someone it applies to, with no way to know.
 */
describe('web/routes/github arrival', () => {
  const app = (deps: Parameters<typeof createGithubArrivalRouter>[0]) => {
    const a = express();
    a.use(createGithubArrivalRouter({ user: () => 'user_1', ...deps }));
    return a;
  };

  it('a GitHub sign-in comes back with the login and the freshest repos', async () => {
    const res = await request(
      app({
        tokenFor: async () => 'gho_x',
        personal: async () => ({
          login: 'greg-builds',
          repos: [{ full_name: 'greg-builds/loom', private: false, pushed_at: '2026-08-20T00:00:00Z' }],
        }),
      }),
    ).get('/api/connectors/github/personal');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: true,
      login: 'greg-builds',
      repos: [{ full_name: 'greg-builds/loom', private: false, pushed_at: '2026-08-20T00:00:00Z' }],
    });
  });

  it('an email or Google sign-in is connected: false — normal, not an error', async () => {
    const res = await request(app({ tokenFor: async () => null })).get('/api/connectors/github/personal');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
  });

  it('GitHub refusing to answer is a 502, never dressed as connected: false', async () => {
    const res = await request(
      app({
        tokenFor: async () => 'gho_x',
        personal: async () => {
          throw new PersonalGithubError('GitHub responded 500');
        },
      }),
    ).get('/api/connectors/github/personal');
    expect(res.status).toBe(502);
    expect(res.body.connected).toBeUndefined();
    expect(res.body.error).toContain('GitHub responded 500');
  });

  it('no session at all is a 401', async () => {
    const a = express();
    a.use(createGithubArrivalRouter({ user: () => null }));
    const res = await request(a).get('/api/connectors/github/personal');
    expect(res.status).toBe(401);
  });
});
