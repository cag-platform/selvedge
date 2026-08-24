import type { ReactNode } from 'react';

/**
 * THE ONE SURVIVOR OF THE DAILY BRIEF.
 *
 * This file was `Brief.tsx` and carried seven exports: a frosted pane, an
 * eyebrow, a headline, an item and a closing line — the whole vocabulary of a
 * page you had to go and read before you could get to your work. That page was
 * retired; its exports were not, because the Styleguide still rendered a sample
 * of it, and a component with one importer is a component no dead-code check
 * will ever flag. Five pieces of a deleted feature stayed compiled and shipped
 * for months on the strength of a demo.
 *
 * What survived is the register shift, and it survived because it is used
 * everywhere: the thread pane, the work card, the timeline, the situation card
 * and the record. Plain language on the surface; the technical line underneath,
 * in mono, if you ask for it. Both registers, neither in the other's way.
 *
 * A real <details>, so keyboards and screen readers get it for free.
 */
export function Reveal({ summary = 'details', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="mt-1 group">
      <summary className="cursor-pointer list-none text-meta text-ink-quiet hover:text-ink-dim [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">{summary}</span>
        <span className="hidden group-open:inline">hide {summary}</span>
      </summary>
      <div className="mt-2 rounded-inset border border-hairline bg-panel-soft px-3 py-2 font-mono text-tech text-ink-dim">
        {children}
      </div>
    </details>
  );
}
