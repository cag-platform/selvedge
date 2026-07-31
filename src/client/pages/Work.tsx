import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { WorkCard } from '../components/WorkCard.js';
import { needsOwner, type WorkCardData, type CardState } from '../lib/card.js';

/**
 * The work surface — every change the loop is walking, the owner's side of it.
 * Cards that need a decision come first (proposals and checkpoint pauses); then
 * what's in motion; then what's finished. The whole thesis in one screen: you
 * are asked, never surprised, and nothing spends past what you approved.
 */

const TERMINAL = new Set<CardState>(['done', 'declined', 'stopped', 'failed']);

export function Work() {
  const [cards, setCards] = useState<WorkCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<{ cards: WorkCardData[] }>('/api/cards')
      .then((r) => setCards(r.cards))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!cards) return <p className="text-body text-ink-quiet">Loading…</p>;

  if (cards.length === 0) {
    return (
      <div className="animate-settle space-y-3">
        <h1 className="text-display font-display font-medium text-ink">Work</h1>
        <p className="text-body text-ink-dim">
          Nothing on the bench. When something breaks that I can fix — or you ask for a change — it shows up here as a
          proposal, with a cost and a stop-point, before anything happens.
        </p>
      </div>
    );
  }

  const attention = cards.filter((c) => needsOwner(c.state));
  const inFlight = cards.filter((c) => !needsOwner(c.state) && !TERMINAL.has(c.state));
  const finished = cards.filter((c) => TERMINAL.has(c.state));

  return (
    <div className="animate-settle space-y-8">
      <h1 className="text-display font-display font-medium text-ink">Work</h1>

      {attention.length > 0 && (
        <Section label="Needs you">
          {attention.map((c) => (
            <WorkCard key={c.id} card={c} onChanged={() => void load()} />
          ))}
        </Section>
      )}

      {inFlight.length > 0 && (
        <Section label="In motion">
          {inFlight.map((c) => (
            <WorkCard key={c.id} card={c} onChanged={() => void load()} />
          ))}
        </Section>
      )}

      {finished.length > 0 && (
        <Section label="Finished">
          {finished.map((c) => (
            <WorkCard key={c.id} card={c} onChanged={() => void load()} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">{label}</p>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
