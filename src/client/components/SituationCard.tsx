import { useState } from 'react';
import { api } from '../lib/api.js';
import { Reveal } from './Brief.js';
import { SelvedgeEdge, StatusDot } from './SelvedgeEdge.js';
import { situationEdge, technicalPresentation, type SituationEvent } from '../lib/situation.js';

export type { SituationEvent } from '../lib/situation.js';

/**
 * The situation card — one live event, made visible to the owner at their own
 * register. This is the surface the monitor and deploy pollers finally reach:
 * every runtime.health_failing / deploy.failed / recovered event the watching
 * loop produces lands here as a card whose selvedge edge carries the verdict.
 *
 * The three registers (the pack's voice.detail_level) change only how much
 * detail rides along, never the verdict or the plain sentence:
 *   plain_only         → the sentence, the edge, nothing technical
 *   plain_expandable   → the sentence + a collapsed "why" in the mono register
 *   technical_forward  → the sentence + the technical line shown inline
 * The plain sentence itself is register-independent and already free of infra
 * nouns (enforced upstream at narration) — a card never says "repository".
 */

/** How sure the narrator was, in the owner's words — low confidence is never hidden to look calmer (Ironclad 2). */
function ConfidenceNote({ confidence }: { confidence?: 'high' | 'medium' | 'low' | null }) {
  if (!confidence || confidence === 'high') return null;
  return <span className="text-ink-quiet">{confidence === 'low' ? 'not sure — checking' : 'fairly sure'}</span>;
}

/**
 * The quiet feedback affordance every narrated item carries (Phase 2
 * deliverable 5). Deliberately no thumbs-up — absence of complaint is the
 * positive signal. Collapsed to a single, near-invisible "wasn't helpful?"
 * so a page of ten items doesn't read as twenty links of chrome; the two
 * real options appear only once the owner reaches for them.
 */
export function FeedbackTaps({ narrationId }: { narrationId: string }) {
  const [state, setState] = useState<'idle' | 'offering' | 'noting' | 'sent'>('idle');
  const [note, setNote] = useState('');

  async function send(kind: 'didnt_help' | 'explain_differently', noteText?: string) {
    try {
      await api.post('/api/feedback', { narration_id: narrationId, kind, ...(noteText ? { note: noteText } : {}) });
    } finally {
      setState('sent');
    }
  }

  if (state === 'sent') return <span className="text-meta text-ink-quiet">noted</span>;

  if (state === 'noting') {
    return (
      <form
        className="mt-1 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send('explain_differently', note);
        }}
      >
        <input
          autoFocus
          className="w-60 rounded-inset border border-hairline bg-panel px-2 py-1 text-meta text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          placeholder="how should this have been said?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="text-meta text-ink-quiet hover:text-ink-dim">
          send
        </button>
      </form>
    );
  }

  if (state === 'offering') {
    return (
      <span className="flex gap-3 text-meta text-ink-quiet">
        <button className="hover:text-ink-dim" onClick={() => void send('didnt_help')}>
          didn’t help
        </button>
        <button className="hover:text-ink-dim" onClick={() => setState('noting')}>
          explain differently
        </button>
      </span>
    );
  }

  return (
    <button
      className="text-meta text-ink-faint transition-colors hover:text-ink-quiet"
      onClick={() => setState('offering')}
    >
      wasn’t helpful?
    </button>
  );
}

/** A short, local-time stamp for the card — "when", in plain words, never a raw ISO string. */
function whenLine(occurredAt: string): string {
  const then = new Date(occurredAt);
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function SituationCard({ event }: { event: SituationEvent }) {
  const edge = situationEdge(event);
  // technical_forward shows the line inline; plain_expandable collapses it;
  // plain_only never carries one (the narration omits it at that register).
  const technical = technicalPresentation(event.detail_level, event.technicalDetail);
  const inlineTechnical = technical === 'inline';
  const when = whenLine(event.occurredAt);

  return (
    <article className="relative rounded-card border border-hairline bg-panel p-4 pl-5">
      <SelvedgeEdge status={edge} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-body text-ink">{event.fragment ?? 'Something changed.'}</p>
        {(event.project_name || when) && (
          <p className="shrink-0 text-meta text-ink-quiet">
            {[event.project_name, when].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      {/* Change→break correlation: a plain lead shown at every register, since
          it's the most actionable thing on the card. Not part of the verdict —
          it's "worth checking first", never "this was the cause". */}
      {event.correlation && (
        <p className="mt-1.5 text-meta text-ink-dim">
          <span className="text-ink-quiet">↩ </span>
          {event.correlation.plain}
        </p>
      )}

      {inlineTechnical && (
        <div className="mt-2 rounded-inset border border-hairline bg-panel-soft px-3 py-2 font-mono text-tech text-ink-dim">
          {event.technicalDetail}
          {event.correlation && <div className="mt-1 text-ink-quiet">{event.correlation.technical}</div>}
          <div className="mt-1 text-ink-quiet">event id: {event.eventId}</div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-meta text-ink-dim">
        {edge !== 'healthy' && <StatusDot status={edge} />}
        <ConfidenceNote confidence={event.confidence} />
        {technical === 'collapsed' && (
          <Reveal summary="why">
            {event.technicalDetail}
            {event.correlation && <div className="mt-1 text-ink-quiet">{event.correlation.technical}</div>}
            <div className="mt-1 text-ink-quiet">event id: {event.eventId}</div>
          </Reveal>
        )}
        <FeedbackTaps narrationId={event.id} />
      </div>
    </article>
  );
}
