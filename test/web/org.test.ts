import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createOrgRouter } from '../../src/server/web/routes/org.js';
import { appWithOrg } from './helpers.js';

/**
 * Timezone drives "local 7:00am" for the brief. Auto-detect (browser)
 * only fills the default; an explicit user choice wins over any later
 * auto-detect from another device.
 */
describe('web/routes/org', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('starts at the UTC default and accepts a browser auto-detect', async () => {
    const app = appWithOrg(orgId, createOrgRouter(db));
    expect((await request(app).get('/api/org')).body).toEqual({
      timezone: 'UTC',
      timezone_source: 'default',
      technical_detail: 'simple',
      preferred_agents: null,
      agent_preferences_set: false,
    });

    const res = await request(app).patch('/api/org/timezone').send({ timezone: 'America/New_York', source: 'auto' });
    expect(res.body).toEqual({ timezone: 'America/New_York', timezone_source: 'auto' });
  });

  it('auto-detect never overrides an explicit user choice', async () => {
    const app = appWithOrg(orgId, createOrgRouter(db));
    await request(app).patch('/api/org/timezone').send({ timezone: 'Europe/Helsinki', source: 'user' });

    const auto = await request(app).patch('/api/org/timezone').send({ timezone: 'America/Chicago', source: 'auto' });
    expect(auto.body.timezone).toBe('Europe/Helsinki');
    expect(auto.body.unchanged).toBe(true);

    // A user choice can still change it.
    const user = await request(app).patch('/api/org/timezone').send({ timezone: 'America/Chicago', source: 'user' });
    expect(user.body.timezone).toBe('America/Chicago');
  });

  it('rejects invalid timezones and sources', async () => {
    const app = appWithOrg(orgId, createOrgRouter(db));
    expect((await request(app).patch('/api/org/timezone').send({ timezone: 'Not/AZone', source: 'user' })).status).toBe(400);
    expect((await request(app).patch('/api/org/timezone').send({ timezone: 'UTC', source: 'wat' })).status).toBe(400);
  });

  it('defaults to Simple technical detail and persists Full as an org presentation preference', async () => {
    const app = appWithOrg(orgId, createOrgRouter(db));
    const changed = await request(app).patch('/api/org/technical-detail').send({ technical_detail: 'full' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ timezone: 'UTC', timezone_source: 'default', technical_detail: 'full' });
    expect((await request(app).get('/api/org')).body.technical_detail).toBe('full');

    expect((await request(app).patch('/api/org/technical-detail').send({ technical_detail: 'plain' })).status).toBe(400);
    expect((await request(app).patch('/api/org/technical-detail').send({ technical_detail: null })).status).toBe(400);
  });

  it('stores the chat and coding agents chosen during onboarding, including an empty help-me-choose answer', async () => {
    const app = appWithOrg(orgId, createOrgRouter(db));
    const saved = await request(app).patch('/api/org/agent-preferences').send({ agents: ['gpt', 'kimi-code', 'gpt'] });
    expect(saved.status).toBe(200);
    expect(saved.body.preferred_agents).toEqual(['gpt', 'kimi-code']);
    expect(saved.body.agent_preferences_set).toBe(true);

    const org = await request(app).get('/api/org');
    expect(org.body.preferred_agents).toEqual(['gpt', 'kimi-code']);
    expect(org.body.agent_preferences_set).toBe(true);

    expect((await request(app).patch('/api/org/agent-preferences').send({ agents: ['not-real'] })).status).toBe(400);
  });
});
