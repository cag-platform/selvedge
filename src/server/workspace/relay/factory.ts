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
  // Previews carry a server-forced CSP sandbox that opaques their origin, so
  // co-hosting with the product is safe by default. A distinct origin is still
  // preferable defense in depth; warn (don't fail) when they share a host.
  const productOrigin = process.env.PUBLIC_ORIGIN?.trim();
  if (productOrigin) {
    try {
      if (new URL(origin).host === new URL(productOrigin).host) {
        console.warn('[preview-relay] PREVIEW_RELAY_PUBLIC_ORIGIN shares a host with PUBLIC_ORIGIN. Previews are sandboxed server-side, but a separate origin is recommended.');
      }
    } catch { /* malformed origin is a config problem surfaced elsewhere */ }
  }
  const sessions = new PreviewRelaySessions(secret, origin);
  const broker = new PreviewRelayBroker();
  shared = { sessions, broker, web: createPreviewRelayWeb(sessions, broker) };
  return shared;
}
