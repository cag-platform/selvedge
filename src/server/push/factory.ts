import { pushEnabled } from './config.js';
import { ApnsPushSender } from './apns.js';
import type { PushSender } from './types.js';

/** One place that decides whether push is on (APNS_* configured) and builds
 * the sender. Returns undefined when unconfigured — callers then no-op. */
export function buildPushSender(): PushSender | undefined {
  if (!pushEnabled()) return undefined;
  return new ApnsPushSender();
}
