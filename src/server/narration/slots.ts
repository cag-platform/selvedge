import type { ContextPack } from '../../shared/types/pack.js';
import type { NarratableEvent } from './types.js';

/** The owner's own name for the project — digest-composer voice rule 4. */
export function projectName(pack: ContextPack): string {
  return pack.identity.name;
}

/** Falls back to a generic phrase when the owner hasn't set one (schema: optional). */
export function downtimeTranslation(pack: ContextPack): string {
  return pack.stakes.downtime_translation || 'the people who use it are affected';
}

export function audience(pack: ContextPack): string {
  return pack.identity.audience || (pack.stakes.has_external_users ? 'your users' : 'just you');
}

/** The collapsed technical line for plain_expandable / technical_forward — built from structured fields only, never `raw`. */
export function technicalLine(event: NarratableEvent): string {
  return `event: ${event.event_type} · occurred ${event.occurred_at} · id ${event.id}`;
}
