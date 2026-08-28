import { PreviewRelayBroker } from './broker.js';
import { PreviewRelaySessions } from './session.js';
import { createPreviewRelayWeb, type PreviewRelayWeb } from './web.js';

export type PreviewRelayService = {
  sessions: PreviewRelaySessions;
  broker: PreviewRelayBroker;
  web: PreviewRelayWeb;
};

let shared: PreviewRelayService | null | undefined;

/** One relay per process; absent configuration keeps the unfinished feature inert. */
export function getPreviewRelay(): PreviewRelayService | null {
  if (shared !== undefined) return shared;
  const secret = process.env.PREVIEW_RELAY_SIGNING_SECRET?.trim();
  const origin = process.env.PREVIEW_RELAY_PUBLIC_ORIGIN?.trim();
  if (!secret || !origin) {
    shared = null;
    return shared;
  }
  const sessions = new PreviewRelaySessions(secret, origin);
  const broker = new PreviewRelayBroker();
  shared = { sessions, broker, web: createPreviewRelayWeb(sessions, broker) };
  return shared;
}
