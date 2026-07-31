import { Router, json } from 'express';
import type { Db } from '../../db/client.js';
import type { NewSelvedgeEvent } from '../../../shared/types/event.js';
import { getPack } from '../../packs/store.js';
import { stepErrorRate } from '../../monitor/errorRate.js';
import { resolveBeacon, touchBeacon, loadErrorState, saveErrorState } from './beaconStore.js';

/**
 * The error beacon receiver — the push transport for runtime.error_rate_spike.
 * An app POSTs its per-window error and request counts with its beacon token;
 * this turns the count into a rate, runs it through the same pure detector the
 * (deferred) pull poller uses, and ingests a spike event when one is confirmed.
 *
 * No session: the beacon token IS the auth, so this is mounted before Clerk,
 * exactly like the GitHub webhook. `ingest` is injected — the same
 * (event, projectId) sink the pollers use — so this connector stays testable
 * without a DB wiring and the connectors→resolution edge stays one-directional.
 *
 * The false-calm discipline is entirely in the detector: a report with no
 * traffic, or a single elevated window, is accepted and stored but announces
 * nothing. A bad token is a flat 401 — we never guess which project an
 * unauthenticated caller meant.
 */

export type BeaconIngest = (event: NewSelvedgeEvent, projectId: string) => Promise<void>;

function asNonNegativeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function createErrorBeaconRouter(deps: { db: Db; ingest: BeaconIngest }) {
  const router = Router();

  router.post('/beacons/errors', json({ limit: '64kb' }), async (req, res) => {
    const token = req.header('x-beacon-token') ?? '';
    const who = await resolveBeacon(deps.db, token);
    if (!who) {
      res.status(401).json({ error: 'invalid beacon token' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors = asNonNegativeNumber(body.errors);
    const requests = asNonNegativeNumber(body.requests);
    if (errors === null || requests === null) {
      res.status(400).json({ error: 'errors and requests must be non-negative numbers' });
      return;
    }

    // No traffic → no error fraction to judge. Accepted, nothing to do.
    if (requests === 0) {
      await touchBeacon(deps.db, who.orgId, who.projectId);
      res.status(202).json({ ok: true, note: 'no traffic in window' });
      return;
    }

    const sourceId = typeof body.source === 'string' && body.source.trim() !== '' ? body.source.trim().slice(0, 64) : 'default';
    const rate = Math.min(1, errors / requests); // a report of more errors than requests caps at 1
    const windowStartedAt = typeof body.window_start === 'string' && !Number.isNaN(Date.parse(body.window_start))
      ? new Date(body.window_start).toISOString()
      : new Date().toISOString();

    // The pack tells us the app's repo, for source_account_id continuity with
    // every other event on this project's timeline.
    const pack = await getPack(deps.db, who.orgId, who.projectId);
    const repoFullName = pack?.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? who.projectId;

    const prev = await loadErrorState(deps.db, who.orgId, who.projectId, sourceId);
    const step = stepErrorRate(prev, { rate, windowStartedAt }, {
      orgId: who.orgId,
      sourceAccountId: repoFullName,
      sourceId: `${who.projectId}:${sourceId}`,
      occurredAt: new Date().toISOString(),
    });
    await saveErrorState(deps.db, who.orgId, who.projectId, sourceId, step.state);
    await touchBeacon(deps.db, who.orgId, who.projectId);

    if (step.event) {
      await deps.ingest(step.event, who.projectId);
    }

    res.status(200).json({ ok: true, spike: Boolean(step.event) });
  });

  return router;
}
