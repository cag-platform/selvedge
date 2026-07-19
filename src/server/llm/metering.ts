import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { llmUsage } from '../db/schema/index.js';
import { costUsd } from './pricing.js';
import type { LlmPurpose, LlmResult } from './types.js';

/**
 * Records every model call — success or failure — against the org. Ships in
 * the same PR as the SDK per the brief: no production call happens without
 * a usage row.
 */
export async function recordUsage(
  db: Db,
  orgId: string,
  purpose: LlmPurpose,
  result: LlmResult,
  eventId?: string,
): Promise<void> {
  await db.insert(llmUsage).values({
    id: ulid(),
    orgId,
    purpose,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: costUsd(result.model, result.tokensIn, result.tokensOut),
    eventId: eventId ?? null,
    ok: result.ok ? 'true' : result.reason,
  });
}
