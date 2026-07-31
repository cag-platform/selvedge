import { useState } from 'react';
import { api } from '../lib/api.js';
import { SelvedgeEdge, StatusDot } from './SelvedgeEdge.js';
import { Reveal } from './Brief.js';
import { cardEdge, stateLabel, formatCents, formatRange, gateNote, type WorkCardData } from '../lib/card.js';

/**
 * One work card, the owner's view of a change the loop is walking. The edge
 * carries where it stands; the body is the plain proposal, the estimate, and
 * the stop-point. The only buttons shown are the owner's real choices at this
 * state — approve/decline when it needs an OK, continue/stop at a checkpoint —
 * and a hard-gate card cannot be approved until the owner confirms a backup.
 */
export function WorkCard({ card, onChanged }: { card: WorkCardData; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupConfirmed, setBackupConfirmed] = useState(false);

  const edge = cardEdge(card.state, card.verdict);
  const hardGate = card.gate === 'hard';
  const note = gateNote(card.risk);

  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/cards/${card.id}/${path}`, body);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="relative rounded-card border border-hairline bg-panel p-4 pl-5">
      <SelvedgeEdge status={edge} />

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-body font-medium text-ink">{card.title}</p>
        <span className="flex shrink-0 items-center gap-2 text-meta text-ink-quiet">
          <StatusDot status={edge} />
          {stateLabel(card.state, card.verdict)}
        </span>
      </div>

      <p className="mt-1.5 text-body text-ink-dim">{card.proposal}</p>

      {/* Estimate and the stop-point — always visible, the money is never buried. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-dim">
        <span>
          Estimate <span className="text-ink">{formatRange(card.estimate.lowCents, card.estimate.highCents)}</span>
        </span>
        <span>
          Stops at <span className="text-ink">{formatCents(card.stop.capCents)}</span>
        </span>
        {card.spentCents > 0 && (
          <span>
            Spent so far <span className="text-ink">{formatCents(card.spentCents)}</span>
          </span>
        )}
      </div>

      {/* The hard-gate note, in plain words, only where it matters. */}
      {note && card.state === 'proposed' && (
        <p className={`mt-2 text-meta ${hardGate ? 'text-ink-dim' : 'text-ink-quiet'}`}>{note}</p>
      )}

      {/* Owner actions — only the real choices for this state. */}
      {card.state === 'proposed' && (
        <div className="mt-3 space-y-2">
          {hardGate && (
            <label className="flex items-start gap-2 text-meta text-ink-dim">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={backupConfirmed}
                onChange={(e) => setBackupConfirmed(e.target.checked)}
              />
              <span>I have a recent backup I can restore from.</span>
            </label>
          )}
          <div className="flex gap-2">
            <button
              disabled={busy || (hardGate && !backupConfirmed)}
              onClick={() => void act('approve', { backup_verified: backupConfirmed })}
              className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => void act('decline')}
              className="rounded-inset px-3 py-1.5 text-body text-ink-quiet hover:text-ink-dim disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {card.state === 'blocked' && (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={() => void act('continue')}
            className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass disabled:opacity-50"
          >
            Continue
          </button>
          <button
            disabled={busy}
            onClick={() => void act('stop')}
            className="rounded-inset px-3 py-1.5 text-body text-ink-quiet hover:text-ink-dim disabled:opacity-50"
          >
            Stop here
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-meta text-thread">{error}</p>}

      {/* The history — the technical register, the seed of the ledger. */}
      {card.acts.length > 0 && (
        <div className="mt-2 flex text-meta text-ink-dim">
          <Reveal summary="history">
            <ol className="space-y-1">
              {card.acts.map((a, i) => (
                <li key={i}>
                  <span className="text-ink-quiet">{a.kind}</span> — {a.detail}
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      )}
    </article>
  );
}
