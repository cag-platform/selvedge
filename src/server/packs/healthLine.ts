import type { ContextPack } from '../../shared/types/pack.js';

/** The Projects list "plain health line" per pack card (deliverable 8). */
export function healthLine(pack: ContextPack): string {
  if (pack.trust?.overall_confidence === 'low') return "I can't verify this project's health right now.";

  const healthy = pack.state?.serving_now?.healthy;
  if (healthy === false) return 'Looks down right now.';

  const gaps = pack.topology.capability_gaps ?? [];
  // YOKE's case: healthy (or unknown, absent a negative signal) but live
  // and incomplete — the gap is the more useful standing status than a
  // bare "healthy".
  if (gaps.length > 0) return `Healthy — ${gaps[0]!.summary}`;

  if (healthy === null || healthy === undefined) {
    return pack.trust?.overall_confidence === 'partial' ? "I can't fully verify this project's health right now." : 'No health signal yet.';
  }
  return 'Healthy.';
}
