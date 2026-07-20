import type { Db } from '../db/client.js';
import type { ConnectorKind } from '../../shared/types/event.js';
import { updateMachineSections } from '../packs/store.js';

/**
 * Rolls a resolved event into its project's pack.state, per deliverable 4:
 * serving_now on deploy events, last_event_at_by_source always. `raw` is
 * never read here — only the refined, structured event_type and timestamp.
 */
export async function updatePackState(
  db: Db,
  orgId: string,
  projectId: string,
  connector: ConnectorKind,
  eventType: string,
  occurredAt: string,
): Promise<void> {
  const patch: Parameters<typeof updateMachineSections>[3] = {
    state: { last_event_at_by_source: { [connector]: occurredAt } },
  };

  if (eventType === 'build.succeeded') {
    patch.state = {
      ...patch.state,
      serving_now: { deployed_at: occurredAt, healthy: true },
      last_successful_deploy: occurredAt,
    };
  } else if (eventType === 'deploy.failed_nothing_serving') {
    patch.state = { ...patch.state, serving_now: { healthy: false } };
  }
  // deploy.failed_previous_serving: serving_now is, by the row's own
  // definition, unchanged — nothing to update.

  await updateMachineSections(db, orgId, projectId, patch);
}
