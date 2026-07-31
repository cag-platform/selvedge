import { useState, type ReactNode } from 'react';
import { SelvedgeEdge, type EdgeStatus } from './SelvedgeEdge.js';
import type { Verdict } from '../lib/verdict.js';
import { verdictToStatus } from '../lib/verdict.js';

/**
 * The brief primitives ("The Look", Prompt 3). The brief is a written note
 * on a frosted pane: top-left specular, selvedge edge carrying the day's
 * top priority, Fraunces for the headline and the close, Inter Tight for
 * the body — and the load-bearing register shift: drilling into an
 * attention item swaps body type for mono.
 */

export function Brief({ status, children }: { status: EdgeStatus; children: ReactNode }) {
  return (
    <article
      className="relative overflow-hidden rounded-pane border border-hairline p-6 pl-7 shadow-sm"
      style={{
        background: 'var(--glass-fill)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
      }}
    >
      <span className="pointer-events-none absolute inset-0" style={{ background: 'var(--specular)' }} aria-hidden />
      <SelvedgeEdge status={status} />
      <div className="relative space-y-5">{children}</div>
    </article>
  );
}

export function BriefEyebrow({ children }: { children: ReactNode }) {
  return <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{children}</p>;
}

export function Headline({ children }: { children: ReactNode }) {
  return <h1 className="text-display font-display font-medium text-ink">{children}</h1>;
}

export function BriefClose({ children }: { children: ReactNode }) {
  return <p className="text-body-lg font-display italic text-ink-dim">{children}</p>;
}

/**
 * The drill-down: plain register on the surface, mono register inside.
 * Uses a real <details> so keyboards and screen readers get it for free.
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

export type BriefItemKind = 'attention' | 'moved' | 'standing' | 'quiet';

/**
 * One item of the note. Attention items carry a verdict (required, always
 * the first sentence — enforced upstream by the composer validator; here
 * the dot just makes it legible) and may carry a mono Reveal.
 */
export function BriefItem({
  kind,
  verdict,
  children,
  reveal,
  actions,
}: {
  kind: BriefItemKind;
  verdict?: Verdict;
  children: ReactNode;
  reveal?: ReactNode;
  actions?: ReactNode;
}) {
  if (kind === 'attention') {
    const status: EdgeStatus = verdict ? verdictToStatus(verdict) : 'needs';
    return (
      <div className="relative pl-4">
        <SelvedgeEdge status={status} />
        <p className="text-lede text-ink">{children}</p>
        {reveal}
        {actions && <div className="mt-1">{actions}</div>}
      </div>
    );
  }
  if (kind === 'moved') {
    return (
      <div>
        <p className="text-body-lg text-ink">{children}</p>
        {actions && <div className="mt-1">{actions}</div>}
      </div>
    );
  }
  if (kind === 'standing') {
    return <p className="text-body text-ink-dim">{children}</p>;
  }
  return <p className="text-body text-ink-quiet">{children}</p>; // quiet
}
