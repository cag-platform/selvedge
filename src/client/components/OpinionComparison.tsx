import type { ReactNode } from 'react';
import { agentById } from '../../shared/agents.js';

type Answer = {
  agent: string;
  body: ReactNode;
};

function nameOf(agent: string): string {
  return agentById(agent)?.name ?? agent;
}

/**
 * Two answers to the same prompt belong beside one another when there is room
 * to compare them. On a narrow viewport they stay in reading order as stacked
 * cards: no hidden tab, swipe gesture, or new phone-only state.
 */
export function OpinionComparison({
  promptId,
  answers,
}: {
  promptId: string;
  answers: readonly [Answer, Answer];
}) {
  const names = answers.map((answer) => nameOf(answer.agent)) as [string, string];
  const titleId = `opinion-comparison-${promptId}`;

  return (
    <section aria-labelledby={titleId} className="rounded-card border border-hairline bg-panel-soft/40 p-work">
      <div className="mb-work flex flex-wrap items-baseline justify-between gap-x-work gap-y-work-tight">
        <h3 id={titleId} className="text-label font-semibold uppercase tracking-widest text-ink-dim">
          Compare opinions
        </h3>
        <p className="text-meta text-ink-quiet">{names[0]} and {names[1]} answered the same question.</p>
      </div>
      {/* The workbench panes are resizable, so viewport breakpoints cannot
          know how much room this comparison actually has. Auto-fit responds
          to the center pane itself: two readable columns when they fit, one
          when either card would become cramped. */}
      <div
        className="grid gap-work"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))' }}
      >
        {answers.map((answer, index) => (
          <article
            key={answer.agent}
            aria-label={`${names[index]} opinion`}
            className="min-w-0 rounded-inset border border-hairline bg-panel px-work py-work"
          >
            {answer.body}
          </article>
        ))}
      </div>
    </section>
  );
}
