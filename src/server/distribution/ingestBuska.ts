import { and, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { distributionIngestionRuns, distributionSignals } from '../db/schema/index.js';
import { DISTRIBUTION_SCOPE } from './domain.js';
import { ingestSignal } from './store.js';
import { BuskaClient } from './providers/buska/client.js';
import { normalizeBuskaMention } from './providers/buska/normalize.js';
import { BUSKA_PLATFORMS, DISTRIBUTION_SEARCH_CONCEPTS } from './searchConcepts.js';
import { buildDistributionClassifierClient } from '../llm/factory.js';
import { processDistributionSignals } from './processSignals.js';

export type BuskaScanClient = Pick<BuskaClient, 'searchMentions'>;
export function configuredBuskaClient(): BuskaClient | null { const key = process.env.BUSKA_API_KEY?.trim(); return key ? new BuskaClient(key, process.env.BUSKA_API_BASE_URL?.trim() || undefined) : null; }

export async function runBuskaScan(db: Db, client: BuskaScanClient, batchSize = 2) {
  const previous = await db.select({ id: distributionIngestionRuns.id }).from(distributionIngestionRuns).where(and(eq(distributionIngestionRuns.orgId, DISTRIBUTION_SCOPE), eq(distributionIngestionRuns.provider, 'buska')));
  const start = (previous.length * batchSize) % DISTRIBUTION_SEARCH_CONCEPTS.length;
  const concepts = Array.from({ length: batchSize }, (_, i) => DISTRIBUTION_SEARCH_CONCEPTS[(start + i) % DISTRIBUTION_SEARCH_CONCEPTS.length]!);
  const searches = concepts.flatMap((keyword) => BUSKA_PLATFORMS.map((platform) => ({ keyword, platform })));
  const id = ulid(); await db.insert(distributionIngestionRuns).values({ id, orgId: DISTRIBUTION_SCOPE, provider: 'buska', searches });
  let found = 0, inserted = 0, duplicates = 0, failures = 0, lastError: string | null = null;
  for (const search of searches) {
    try {
      const result = await client.searchMentions(search.keyword, search.platform, 50); found += result.results.length;
      for (const mention of result.results) { const saved = await ingestSignal(db, normalizeBuskaMention(mention, search.platform, search.keyword)); saved.inserted ? inserted++ : duplicates++; }
    } catch (error) { failures++; lastError = error instanceof Error ? error.message : 'Buska search failed'; }
  }
  const status = failures === searches.length ? 'FAILED' : failures > 0 ? 'PARTIAL' : 'SUCCEEDED';
  const [run] = await db.update(distributionIngestionRuns).set({ status, finishedAt: new Date(), recordsFound: found, recordsInserted: inserted, duplicates, failures, lastError }).where(eq(distributionIngestionRuns.id, id)).returning();
  return run!;
}

export async function runBuskaPipeline(db: Db, client: BuskaScanClient, batchSize = 2) {
  const run = await runBuskaScan(db, client, batchSize); const classifier = buildDistributionClassifierClient();
  const processing = classifier ? await processDistributionSignals(db, classifier) : null; return { run, processing };
}

export async function buskaStatus(db: Db) {
  const [last] = await db.select().from(distributionIngestionRuns).where(and(eq(distributionIngestionRuns.orgId, DISTRIBUTION_SCOPE), eq(distributionIngestionRuns.provider, 'buska'))).orderBy(desc(distributionIngestionRuns.startedAt)).limit(1);
  const [count] = await db.select({ count: sql<number>`count(*)` }).from(distributionSignals).where(and(eq(distributionSignals.orgId, DISTRIBUTION_SCOPE), eq(distributionSignals.provider, 'buska')));
  const [success] = await db.select({ finishedAt: distributionIngestionRuns.finishedAt }).from(distributionIngestionRuns).where(and(eq(distributionIngestionRuns.orgId, DISTRIBUTION_SCOPE), eq(distributionIngestionRuns.provider, 'buska'), eq(distributionIngestionRuns.status, 'SUCCEEDED'))).orderBy(desc(distributionIngestionRuns.startedAt)).limit(1);
  const now = new Date(); const next = new Date(now); next.setUTCMinutes(0, 0, 0); next.setUTCHours(now.getUTCHours() < 12 ? 12 : 24);
  return { configured: Boolean(process.env.BUSKA_API_KEY?.trim()), lastSuccessfulScan: success?.finishedAt ?? null, nextScheduledScan: next, lastScan: last ?? null, signalsIngested: Number(count?.count ?? 0), lastError: last?.lastError ?? null };
}
