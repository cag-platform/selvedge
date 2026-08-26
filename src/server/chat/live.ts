import { randomUUID } from 'node:crypto';

export type LiveCapability = 'chat' | 'build' | 'visual';
export type LiveChatEvent =
  | { type: 'reply_started'; turnId: string; agent: string; consultationId?: string; capability: LiveCapability }
  | { type: 'reply_delta'; turnId: string; agent: string; consultationId?: string; capability: LiveCapability; text: string }
  | { type: 'reply_finished'; turnId: string; agent: string; consultationId?: string; capability: LiveCapability }
  | { type: 'reply_cancelled'; turnId: string; agent: string; consultationId?: string; capability: LiveCapability };

type Listener = (event: LiveChatEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const key = (orgId: string, threadId: string) => `${orgId}:${threadId}`;
const channel = 'selvedge_chat_live';
const instanceId = randomUUID();
let relayStarted = false;

type RelayEnvelope = { instanceId: string; orgId: string; threadId: string; event: LiveChatEvent };

function deliver(orgId: string, threadId: string, event: LiveChatEvent): void {
  for (const listener of listeners.get(key(orgId, threadId)) ?? []) listener(event);
}

function ensureRelay(): void {
  if (relayStarted || process.env.NODE_ENV === 'test') return;
  relayStarted = true;
  void import('../db/client.js').then(({ sql }) => sql.listen(channel, (payload) => {
      try {
        const envelope = JSON.parse(payload) as RelayEnvelope;
        if (envelope.instanceId !== instanceId) deliver(envelope.orgId, envelope.threadId, envelope.event);
      } catch {
        // A malformed notification is not allowed to take down the SSE path.
      }
    })).catch((error) => {
    relayStarted = false;
    console.error('live chat relay could not subscribe:', error);
  });
}

export function publishLiveChat(orgId: string, threadId: string, event: LiveChatEvent): void {
  // PostgreSQL NOTIFY payloads are capped at 8 KB. Provider chunks are
  // normally tiny, but splitting here makes that an invariant rather than an
  // assumption (and still preserves exact ordering).
  const events = event.type === 'reply_delta' && event.text.length > 1_500
    ? (event.text.match(/[\s\S]{1,1500}/g) ?? []).map((text) => ({ ...event, text }))
    : [event];
  for (const next of events) {
    deliver(orgId, threadId, next);
    if (process.env.NODE_ENV !== 'test') {
      ensureRelay();
      const envelope: RelayEnvelope = { instanceId, orgId, threadId, event: next };
      void import('../db/client.js')
        .then(({ sql }) => sql.notify(channel, JSON.stringify(envelope)))
        .catch((error) => console.error('live chat relay could not publish:', error));
    }
  }
}

export function subscribeLiveChat(orgId: string, threadId: string, listener: Listener): () => void {
  ensureRelay();
  const k = key(orgId, threadId);
  const set = listeners.get(k) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(k, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(k);
  };
}
