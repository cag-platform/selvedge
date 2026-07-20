import type { ReactNode } from 'react';

/**
 * Shared form/control classes ("The Look", Prompt 5) — tokens only, brass
 * focus rings everywhere, no color/radius/type outside the token set.
 */

export const inputCls =
  'mt-1 w-full rounded-inset border border-hairline bg-panel px-2.5 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass';

export const btnPrimary =
  'rounded-inset bg-ink px-4 py-1.5 text-body font-medium text-panel transition-opacity duration-settle ease-settle hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:opacity-50';

export const btnGhost =
  'rounded-inset px-4 py-1.5 text-body text-ink-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass';

export const labelCls = 'block text-body text-ink-dim';

export const eyebrowCls = 'text-label font-body uppercase tracking-widest text-ink-faint';

/**
 * A pane. Solid --panel by design, not just as fallback: the glass budget
 * (tokens.css) allows two blurred layers per screen — nav + brief — and
 * ordinary panes sit on flat paper where blur buys nothing.
 */
export function Pane({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`relative rounded-card border border-hairline bg-panel p-4 ${className}`}>{children}</div>;
}
