import type { Db } from '../db/client.js';
import type { NewSelvedgeEvent } from '../../shared/types/event.js';
import { stepErrorRate, FRESH, type ErrorRateSample, type ErrorRateState } from './errorRate.js';

/**
 * The error-rate poller — the running loop that turns an app's per-window error
 * fraction into `runtime.error_rate_spike` events, via the pure detector in
 * errorRate.ts. Same shape as the health and deploy pollers: everything
 * external is injected, so the whole loop is testable without a network.
 *
 * The per-source detector state is held across ticks by the caller (in-process,
 * the documented single-process tradeoff — a restart re-warms the baseline from
 * a clean slate, and never announces a spike until it has).
 *
 * A window we can't read this tick (`readSample` returns null) is a gap in
 * visibility, not a data point: we do not fold it into the baseline and we do
 * not treat the surrounding windows as consecutive across it — the run resets,
 * so a spike still needs two windows we actually observed. Losing sight never
 * manufactures a spike, and never silences one we'd already announced.
 *
 * The transport that produces the samples — a log tail, an error connector, or
 * an inbound beacon the app posts to — is deferred, exactly as the Railway
 * deploy poller's real service discovery is; only the injected `readSample`
 * seam differs between the test and the (future) live wiring.
 */

export type ErrorSourceToPoll = {
  orgId: string;
  /** The project these errors belong to — passed to ingest so events place without source resolution. */
  projectId: string;
  /** A stable id for this error source, for state keying and the dedupe key. */
  sourceId: string;
  /** GitHub repo full name for source_account_id continuity with build/deploy/health events. */
  repoFullName: string;
};

export type ErrorPollDeps = {
  db: Db;
  /** Which sources to read this tick — real impl reads packs with an error source. */
  listSources: () => Promise<ErrorSourceToPoll[]>;
  /** Read a source's error fraction for the latest window, or null if it can't be read. */
  readSample: (src: ErrorSourceToPoll) => Promise<ErrorRateSample | null>;
  /** Where emitted events go. Real impl is the shared ingest sink. */
  ingest: (event: NewSelvedgeEvent, projectId: string) => Promise<void>;
  /** The per-source detector state, held across ticks by the caller. */
  state: Map<string, ErrorRateState>;
  now?: () => Date;
};

/** One poll tick over all error sources. Returns the events emitted, for observability and tests. */
export async function pollErrorRates(deps: ErrorPollDeps): Promise<NewSelvedgeEvent[]> {
  const now = deps.now ?? (() => new Date());
  const emitted: NewSelvedgeEvent[] = [];

  const sources = await deps.listSources();
  for (const src of sources) {
    const prev = deps.state.get(src.sourceId) ?? FRESH;

    let sample: ErrorRateSample | null;
    try {
      sample = await deps.readSample(src);
    } catch {
      sample = null; // a read failure is "can't tell", never a spike
    }

    if (sample == null) {
      // Gap in visibility: don't advance the baseline, and break the run so we
      // never call two non-adjacent elevated windows "consecutive".
      if (prev.consecutiveElevated !== 0) deps.state.set(src.sourceId, { ...prev, consecutiveElevated: 0 });
      continue;
    }

    const step = stepErrorRate(prev, sample, {
      orgId: src.orgId,
      sourceAccountId: src.repoFullName,
      sourceId: src.sourceId,
      occurredAt: now().toISOString(),
    });
    deps.state.set(src.sourceId, step.state);

    if (step.event) {
      await deps.ingest(step.event, src.projectId);
      emitted.push(step.event);
    }
  }

  return emitted;
}
