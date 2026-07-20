import type { ContextPack } from '../../shared/types/pack.js';
import type { EventType } from '../../shared/types/event.js';
import { matchesKnownFlaky } from './knownFlaky.js';

/**
 * Pack-aware event_type refinement, run once resolution knows which
 * project (and therefore which pack) an event belongs to — the connector
 * normalizer can't do this since it has no pack access.
 *
 * - deploy.failed_previous_serving is the normalizer's provisional guess
 *   (GitHub alone can't see host state); upgraded to
 *   deploy.failed_nothing_serving when the pack shows nothing has ever
 *   served.
 * - build.failed is upgraded to build.failed_known_flaky when the failing
 *   workflow's name matches one of the pack's known_flaky patterns.
 */
export function refineEventType(eventType: string, raw: unknown, pack: ContextPack): EventType | string {
  if (eventType === 'deploy.failed_previous_serving' && !pack.state?.serving_now?.deployed_at) {
    return 'deploy.failed_nothing_serving';
  }
  if (eventType === 'build.failed' && matchesKnownFlaky(raw, pack)) {
    return 'build.failed_known_flaky';
  }
  return eventType;
}
