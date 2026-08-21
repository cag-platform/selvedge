import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { llmUsage } from '../db/schema/index.js';
import { costUsd, providerForModel } from './pricing.js';
import type { LlmPurpose, LlmResult } from './types.js';

/**
 * Records every model call — success or failure — against the org. Ships in
 * the same PR as the SDK per the brief: no production call happens without
 * a usage row.
 *
 * The provider comes from the client when it knows (authoritative), and
 * otherwise from the pricing table by model id. A model nobody priced records
 * as 'unknown' rather than defaulting to the incumbent — an unattributed row
 * is a visible gap in the ledger, a misattributed one is a silent error.
 */
export async function recordUsage(
  db: Db,
  orgId: string,
  purpose: LlmPurpose,
  result: LlmResult,
  eventId?: string,
  threadId?: string,
): Promise<void> {
  await db.insert(llmUsage).values({
    id: ulid(),
    orgId,
    purpose,
    model: result.model,
    provider: result.provider ?? providerForModel(result.model),
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: costUsd(result.model, result.tokensIn, result.tokensOut),
    eventId: eventId ?? null,
    // The conversation this call belongs to, when it belongs to one — so a
    // thread can show what it has cost without a second ledger.
    threadId: threadId ?? null,
    ok: result.ok ? 'true' : result.reason,
  });
}
