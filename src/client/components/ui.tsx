import { useEffect, useState, type ReactNode } from 'react';

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

/**
 * A PANE HOLDS ITS SHAPE WHILE IT FILLS.
 *
 * A spinner says "something is happening"; a skeleton says "this is what is
 * about to be here", which is the more useful sentence and the one that stops
 * the page jumping when the data lands. Nothing here flashes white and nothing
 * moves after first paint.
 *
 * SHAPED, NOT GENERIC. Three grey bars mean nothing; a rail of edge-stub-plus-
 * two-lines is recognisably the rail. So the skeletons below are per-surface
 * rather than one reusable "loading box", and they render INSIDE the three-pane
 * frame so the frame itself never moves.
 *
 * The one grey bar below is the shared brushstroke the shaped skeletons paint
 * with — deliberately not exported, so nobody assembles a loading state out of
 * it somewhere else.
 */

function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-breathe rounded-inset bg-panel ${className}`} />;
}
/**
 * WHEN TO SHOW ONE.
 *
 * Not immediately: a skeleton that appears and vanishes inside 150ms is its own
 * flash of jank, and most local responses land inside that. And not forever
 * either — past eight seconds a skeleton is a lie by omission, so the surface
 * says the true thing instead and keeps waiting.
 *
 * Returns what the surface should do: nothing yet, the shape, or the sentence.
 */
export const SKELETON_AFTER_MS = 150;
export const SLOW_AFTER_MS = 8_000;
export const SLOW_LINE = 'Still loading — the server is slow right now.';

export function useLoadingPhase(loading: boolean): 'idle' | 'skeleton' | 'slow' {
  const [phase, setPhase] = useState<'idle' | 'skeleton' | 'slow'>('idle');
  useEffect(() => {
    if (!loading) {
      setPhase('idle');
      return;
    }
    const toSkeleton = setTimeout(() => setPhase('skeleton'), SKELETON_AFTER_MS);
    const toSlow = setTimeout(() => setPhase('slow'), SLOW_AFTER_MS);
    return () => {
      clearTimeout(toSkeleton);
      clearTimeout(toSlow);
    };
  }, [loading]);
  return phase;
}

/** The rail, before it has rows: an edge stub and two lines, five times. */
export function RailSkeleton() {
  return (
    <div className="p-work" aria-busy="true" aria-label="Loading your projects">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="mb-work-tight flex items-center gap-work px-work-tight py-work">
          <Skeleton className="h-8 w-[3px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5 pl-work">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A conversation, before its messages: three of them, alternating sides. */
export function ThreadSkeleton() {
  return (
    <div className="space-y-work-loose px-work-loose py-work" aria-busy="true" aria-label="Loading this conversation">
      {[
        'w-3/5',
        'w-4/5',
        'w-2/3',
      ].map((width, i) => (
        <div key={i} className={i % 2 === 1 ? 'border-l-2 border-hairline pl-work' : 'pl-6'}>
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className={`mt-2 h-3 ${width}`} />
          <Skeleton className="mt-1.5 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** The context panel, before its data: the tab strip and one card. */
export function ContextSkeleton() {
  return (
    <div className="space-y-work p-work" aria-busy="true" aria-label="Loading the context panel">
      <div className="flex gap-work-tight">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="space-y-2 rounded-card border border-hairline p-work">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-4/5" />
      </div>
    </div>
  );
}
