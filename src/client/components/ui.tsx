import type { ReactNode } from 'react';

/**
 * Shared form/control classes ("The Look", Prompt 5) — tokens only, the
 * interaction emerald on every focus ring, no color/radius/type outside
 * the token set.
 */

export const inputCls =
  'mt-1 w-full rounded-inset border border-hairline bg-panel px-2.5 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright';

// Deep emerald with cream ink — Toile's signature CTA, the one "doing" color.
export const btnPrimary =
  'rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity duration-settle ease-settle hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50';

export const btnGhost =
  'rounded-inset px-4 py-1.5 text-body text-ink-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright';

// Destructive action. thread is the app's rationed color; a real, irreversible
// delete (the one place a project can be removed) is exactly the kind of
// "this needs you" moment it's reserved for.
export const btnDanger =
  'rounded-inset border border-thread px-4 py-1.5 text-body text-thread transition-[background-color,color] duration-settle ease-settle hover:bg-thread hover:text-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50';

export const labelCls = 'block text-body text-ink-dim';

export const eyebrowCls = 'text-label font-body uppercase tracking-widest text-ink-quiet';

/**
 * A pane. Solid --panel by design, not just as fallback: the glass budget
 * (tokens.css) allows two blurred layers per screen — nav + brief — and
 * ordinary panes sit on flat paper where blur buys nothing.
 */
export function Pane({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`relative rounded-card border border-hairline bg-panel p-4 ${className}`}>{children}</div>;
}

/**
 * AN EMPTY SCREEN IS AN INVITATION TO ACT.
 *
 * Every pane in Selvedge has a state where there is nothing in it yet, and
 * that state is reached most often by the person who has been here least. A
 * blank rectangle teaches them the product is broken; a spinner teaches them
 * to wait for something that is never coming; developer placeholder text
 * teaches them it is unfinished. So each one says what this place is for and
 * offers at most one thing to do.
 *
 * THE RULES, which are as much about restraint as about copy:
 *
 *  - No illustration, no icon, no sad face. The reading register is text, and
 *    a drawing here is decoration standing in for an explanation.
 *  - At most ONE action. Two choices in an empty room is a menu, and a menu is
 *    what somebody with nothing yet least needs.
 *  - Rust never appears. `--thread` means "this needs you"; nothing being here
 *    yet is not a problem, and colouring it like one would spend the product's
 *    single loudest signal on the calmest moment it has.
 */
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  /** At most one. A second would make this a menu. */
  action?: ReactNode;
}) {
  return (
    <div className="max-w-prose py-work">
      <p className="text-body text-ink-dim">{children}</p>
      {action && <div className="mt-work">{action}</div>}
    </div>
  );
}
