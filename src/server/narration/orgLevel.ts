import type { NarrationOutput } from './types.js';

/**
 * E1 (connector auth failed) and E4 (unmappable events accumulating) are
 * about the org's connectors/tray, not any one project — there's no pack
 * to slot-fill from, and the routing doc marks E1 as pushing "regardless
 * of tier" anyway. These bypass route()/narrate() entirely; callers persist
 * them as a narration row with project_id null so they still surface on
 * the Today page (acceptance gate 6) ahead of the digest.
 */

export function connectorAuthFailedNarration(connectorLabel: string): NarrationOutput {
  return {
    fragment: `I've lost access to ${connectorLabel} — I can't tell yet what's happening there, and won't until it's reconnected. Reconnect it when you get a chance.`,
    verdict: 'cannot_tell',
  };
}

export function unsortedTrayNarration(count: number): NarrationOutput {
  return {
    fragment: `${count} event${count === 1 ? '' : 's'} I couldn't match to a project — 30 seconds to sort?`,
  };
}
