import { useEffect, useRef } from 'react';
import { AgentChip } from './AgentChip.js';
import { offersMatching, type AgentOffer } from '../lib/agents.js';
import type { AgentId } from '../../shared/agents.js';

/**
 * THE ROSTER, WHERE THE CHOICE IS ACTUALLY MADE — in the composer, over the
 * half-typed `@`.
 *
 * This used to be a picker: a menu you opened, filtered by a thread "kind" you
 * had chosen earlier and could not see, showing two of four agents with the
 * other two marked "not yet". Three separate ways of being unhelpful. Now:
 *
 *   What can answer is listed — the agents this org has actually connected.
 *     Eight orange "no key" rows drowned the three real choices once the
 *     registry grew; the full list with every reason lives in Connections,
 *     where a key can actually be added (offersMatching does the filtering).
 *   Every entry says what it DOES ("changes files"), not what it needs.
 *   Every entry says what switching to it COSTS, before you pick it, from the
 *     server's own quote — the same code that will do the charging.
 *   A blocker this conversation can fix (a builder with no project) stays
 *     visible, in words — and typing any hidden name in full still gets the
 *     honest note at send time.
 *
 * Picking inserts `@name` rather than switching behind your back, so the
 * choice is visible in the sentence, costs nothing until you send, and comes
 * back with one press of backspace.
 */
export function AgentMenu({
  agents,
  query,
  onPick,
  onDismiss,
}: {
  agents: AgentOffer[];
  /** The half-typed name at the caret. Null when the menu should be closed. */
  query: string | null;
  onPick: (agent: AgentId) => void;
  onDismiss: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const shown = query === null ? [] : offersMatching(agents, query);

  useEffect(() => {
    if (query === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [query, onDismiss]);

  if (query === null || shown.length === 0) return null;

  return (
    <div
      ref={box}
      role="listbox"
      aria-label="Who should answer"
      className="absolute bottom-full left-0 z-20 mb-work w-[26rem] max-w-[calc(100vw-2rem)] animate-settle rounded-card border border-hairline bg-panel p-work-tight shadow-lg"
    >
      <div className="mb-work-tight border-b border-hairline px-work-tight pb-work-tight">
        <p className="text-body font-medium text-ink">Choose the best builder for this turn.</p>
        <p className="mt-0.5 text-meta text-ink-dim">The project’s decisions, evidence, language, and history stay attached when the builder changes.</p>
      </div>
      {shown.map((offer) => (
        <button
          key={offer.id}
          type="button"
          role="option"
          aria-selected={offer.answering_now}
          onClick={() => onPick(offer.id)}
          className="flex w-full items-start gap-work rounded-inset px-work-tight py-work-tight text-left hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          <span className="mt-0.5">
            <AgentChip agent={offer.id} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-work">
              <span className="text-body text-ink">{offer.name}</span>
              {/* The price tag. Never a receipt — this is read before the
                  decision, which is the entire point of it existing. */}
              <span
                className={`font-mono text-tech ${
                  offer.answering_now ? 'text-ink-quiet' : offer.handoff && offer.handoff.tokens > 0 ? 'text-brass' : 'text-healthy'
                }`}
              >
                {offer.answering_now ? 'answering now' : (offer.handoff?.note ?? 'switching is free')}
              </span>
            </span>
            {/* What it does — the whole of what a thread "kind" used to decide,
                said in the one place the choice is being made. */}
            <span className="block text-meta text-ink-dim">{offer.does}</span>
            <span className="block text-meta text-ink-quiet">{offer.cost_note}</span>
            {/* Not hidden when it can't run — told, so it can be fixed. */}
            {!offer.available && offer.unavailable_note && (
              <span className="mt-0.5 block text-meta text-thread">{offer.unavailable_note}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
