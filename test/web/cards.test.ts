import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard } from '../../src/server/cards/store.js';
import { createCardsRouter } from '../../src/server/web/routes/cards.js';
import { appWithOrg } from './helpers.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';

const T = '2026-07-31T12:00:00Z';

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    id: 'card_1',
    orgId: 'org_1',
    projectId: 'loom',
    trigger: 'request',
    title: 'Make the gift note optional',
    proposal: "I'd make the gift-note field optional at checkout.",
    signals: {},
    estimate: { lowCents: 400, highCents: 900 },
    capCents: 1500,
    now: T,
    ...overrides,
  };
}

describe('web/routes/cards — the owner side of the loop', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  const app = () => appWithOrg(orgId, createCardsRouter(db));

  it('lists and fetches an org\'s cards', async () => {
    await createCard(db, input());
    const list = await request(app()).get('/api/cards');
    expect(list.body.cards).toHaveLength(1);
    const one = await request(app()).get('/api/cards/card_1');
    expect(one.body.card.title).toBe('Make the gift note optional');
  });

  it('approves an ordinary card', async () => {
    await createCard(db, input());
    const res = await request(app()).post('/api/cards/card_1/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.card.state).toBe('approved');
  });

  it('refuses to approve a sensitive card without a backup, in plain words', async () => {
    await createCard(db, input({ signals: { touchesPayments: true } }));
    const res = await request(app()).post('/api/cards/card_1/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('backup_required');
    expect(res.body.message).toMatch(/verified backup/i);
  });

  it('approves a sensitive card once a backup is confirmed', async () => {
    await createCard(db, input({ signals: { touchesAuth: true } }));
    const res = await request(app()).post('/api/cards/card_1/approve').send({ backup_verified: true });
    expect(res.status).toBe(200);
    expect(res.body.card.state).toBe('approved');
    expect(res.body.card.backupVerified).toBe(true);
  });

  it('declines a card', async () => {
    await createCard(db, input());
    const res = await request(app()).post('/api/cards/card_1/decline').send({ reason: 'not now' });
    expect(res.body.card.state).toBe('declined');
  });

  it('a second action on a finished card is a plain 409, not a 500', async () => {
    await createCard(db, input());
    await request(app()).post('/api/cards/card_1/decline').send({});
    const res = await request(app()).post('/api/cards/card_1/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('terminal');
  });

  it('another org cannot see or act on the card', async () => {
    await createCard(db, input());
    const other = appWithOrg('org_2', createCardsRouter(db));
    expect((await request(other).get('/api/cards/card_1')).status).toBe(404);
    expect((await request(other).post('/api/cards/card_1/approve').send({})).status).toBe(404);
  });
});
