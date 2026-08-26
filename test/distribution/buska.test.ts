import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { distributionIngestionRuns, distributionSignals } from '../../src/server/db/schema/index.js';
import { BuskaClient, BuskaError } from '../../src/server/distribution/providers/buska/client.js';
import { normalizeBuskaMention } from '../../src/server/distribution/providers/buska/normalize.js';
import { configuredBuskaClient, runBuskaScan } from '../../src/server/distribution/ingestBuska.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Buska provider', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('normalizes a provider response without promoting Buska scoring into domain scores', () => {
    const row = normalizeBuskaMention({ name: 'Ada', channel: 'reddit', intent: 'PAIN', aiScore: 9, aiReason: 'pain', contentPreview: 'My coding agent forgot the whole project', postUrl: 'https://reddit.com/r/a/1', link: 'https://reddit.com/u/ada', publishedAt: '2026-08-20T10:00:00Z' }, 'reddit', 'project memory');
    expect(row).toMatchObject({ provider: 'buska', platform: 'reddit', authorName: 'Ada', content: 'My coding agent forgot the whole project' });
    expect(row.rawPayload).toMatchObject({ aiScore: 9, intent: 'PAIN', selvedgeSearchKeyword: 'project memory' });
    expect(row).not.toHaveProperty('overallScore'); expect(row.dedupeKey).toMatch(/^buska:/);
  });

  it('uses current auth/body shape and retries transient API failures', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({ results: [{ contentPreview: 'x' }], total: 1 }));
    const out = await new BuskaClient('secret', 'https://api.test/v1', fetcher).searchMentions('AI coding', 'reddit', 10);
    expect(out.total).toBe(1); expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[1]!; expect(init.headers['x-api-key']).toBe('secret'); expect(JSON.parse(init.body)).toEqual({ keyword: 'AI coding', platform: 'reddit', limit: 10 });
  });

  it('surfaces a terminal API failure after bounded retries', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}, 500));
    await expect(new BuskaClient('secret', 'https://api.test/v1', fetcher, 1).searchMentions('Codex', 'twitter')).rejects.toEqual(expect.objectContaining({ name: 'BuskaError', status: 500 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('paginates qualified signals with documented limit and offset', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ signals: [{ postUrl: '1' }, { postUrl: '2' }], total: 3 })).mockResolvedValueOnce(json({ signals: [{ postUrl: '3' }], total: 3 }));
    const rows = []; for await (const row of new BuskaClient('key', 'https://api.test/v1', fetcher).signals({ platform: 'reddit' }, 2)) rows.push(row);
    expect(rows.map((r) => r.postUrl)).toEqual(['1', '2', '3']);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining('offset=0'), expect.stringContaining('offset=2')]);
  });

  it('fails closed when credentials are missing', () => { vi.stubEnv('BUSKA_API_KEY', ''); expect(configuredBuskaClient()).toBeNull(); });
});

describe('Buska ingestion accounting', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { const test = await createTestDb(); db = test.db; close = test.close; }); afterEach(async () => close());
  it('accounts for inserts, duplicates, and per-search failures without taking down the run', async () => {
    let call = 0;
    const client = { searchMentions: vi.fn(async (_keyword: string, platform: string) => {
      call++; if (platform === 'hackernews') throw new BuskaError('temporary outage', 503);
      return { results: [{ channel: platform, contentPreview: 'Agent lost context', postUrl: 'https://same.example/post', aiScore: 10 }], total: 1 };
    }) };
    const run = await runBuskaScan(db, client, 1);
    expect(run).toMatchObject({ status: 'PARTIAL', recordsFound: 2, recordsInserted: 1, duplicates: 1, failures: 1, lastError: 'temporary outage' });
    expect(client.searchMentions).toHaveBeenCalledTimes(3);
    expect((await db.select().from(distributionSignals)).length).toBe(1);
    expect((await db.select().from(distributionIngestionRuns).where(eq(distributionIngestionRuns.id, run.id)))[0]?.finishedAt).not.toBeNull();
  });
});
