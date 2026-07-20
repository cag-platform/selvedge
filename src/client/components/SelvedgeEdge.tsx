/**
 * The signature element ("The Look", Prompt 2): a vertical status seam down
 * the left of the brief and every project card — the selvedge edge of the
 * cloth. A stranger should read the whole stack's health from the edges
 * alone.
 *
 * Status vocabulary (fixed):
 *   healthy  → --healthy solid          (users_fine / quiet good)
 *   working  → --brass solid            (in motion, attention-adjacent)
 *   needs    → --thread solid + glow    (the ONLY place thread appears)
 *   unknown  → --ink-faint DASHED       (cannot_tell — shape-distinct from
 *                                        healthy so "I can't see this"
 *                                        never reads as "fine")
 */

export type EdgeStatus = 'healthy' | 'working' | 'needs' | 'unknown';

const EDGE_COLOR: Record<EdgeStatus, string> = {
  healthy: 'var(--healthy)',
  working: 'var(--brass)',
  needs: 'var(--thread)',
  unknown: 'var(--ink-faint)',
};

export function SelvedgeEdge({ status }: { status: EdgeStatus }) {
  const color = EDGE_COLOR[status];
  if (status === 'unknown') {
    // Dashed: rendered as a repeating gradient so the seam stays crisp at
    // any height (border-style dashes scale unevenly).
    return (
      <span
        aria-hidden
        className="absolute inset-y-2 left-0 w-[3px] rounded-full"
        style={{
          background: `repeating-linear-gradient(to bottom, ${color} 0 6px, transparent 6px 12px)`,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="absolute inset-y-2 left-0 w-[3px] rounded-full"
      style={{
        background: color,
        boxShadow: status === 'needs' ? `0 0 8px 1px color-mix(in srgb, ${color} 55%, transparent)` : undefined,
      }}
    />
  );
}

/** Small inline companion for rows and labels; same vocabulary, same rationing. */
export function StatusDot({ status }: { status: EdgeStatus }) {
  const color = EDGE_COLOR[status];
  if (status === 'unknown') {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full border border-dashed bg-transparent align-middle"
        style={{ borderColor: color }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full align-middle"
      style={{
        background: color,
        boxShadow: status === 'needs' ? `0 0 6px color-mix(in srgb, ${color} 55%, transparent)` : undefined,
      }}
    />
  );
}
