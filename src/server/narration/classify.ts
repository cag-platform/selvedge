/**
 * Which digest-composer §2 section a routed row belongs in. Set once, at
 * narration-persist time, so the digest layer never has to re-derive it
 * from the routing table at query time.
 */
export type NarrationKind = 'attention' | 'moved' | 'standing';

const ATTENTION_ROWS = new Set(['B3', 'B4', 'B5', 'B6', 'B7', 'C1', 'C4', 'C5', 'C6', 'C7', 'E2']);
const MOVED_ROWS = new Set(['A2', 'A3', 'A4', 'A6', 'B2', 'C2', 'C3']);
const STANDING_ROWS = new Set(['A5', 'E4']);

export function classifyRow(rowId: string): NarrationKind {
  if (ATTENTION_ROWS.has(rowId)) return 'attention';
  if (MOVED_ROWS.has(rowId)) return 'moved';
  if (STANDING_ROWS.has(rowId)) return 'standing';
  // Any row reachable here (v1_scope rows not explicitly listed above)
  // defaults to 'attention' — safer to over-surface than to silently drop
  // something the router thought was worth a DIGEST/PUSH delivery.
  return 'attention';
}
