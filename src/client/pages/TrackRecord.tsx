import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { SelvedgeEdge, StatusDot } from '../components/SelvedgeEdge.js';
import { entryEdge, outcomeLabel, formatCents, type LedgerEntryData, type LedgerSummaryData } from '../lib/ledger.js';
import { Reveal } from '../components/Brief.js';
import { describeAct, type ActView } from '../lib/replay.js';
import { EmptyState } from '../components/ui.js';

/**
 * The track record — what Selvedge has actually done, what it cost, and how it
 * turned out. The remembered app made legible: not a marketing number but the
 * honest history, misses included, that also feeds every future estimate.
 */

type StackMemory = { summary: string };

export function TrackRecord() {
  const [entries, setEntries] = useState<LedgerEntryData[] | null>(null);
  const [summary, setSummary] = useState<LedgerSummaryData | null>(null);
  const [memory, setMemory] = useState<StackMemory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ entries: LedgerEntryData[]; summary: LedgerSummaryData }>('/api/ledger')
      .then((r) => {
        setEntries(r.entries);
        setSummary(r.summary);
      })
      .catch((e: Error) => setError(e.message));
    api.get<StackMemory>('/api/memory').then(setMemory).catch(() => setMemory(null));
  }, []);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!entries || !summary) return <p className="text-body text-ink-quiet">Loading…</p>;

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Track record</h1>
        {memory && <p className="mt-2 max-w-xl text-body text-ink-dim">{memory.summary}</p>}
      </div>

      {summary.total > 0 && (
        <section className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat n={summary.shipped} label="shipped" />
          <Stat n={summary.total} label="changes in all" />
          <Stat text={formatCents(summary.spentCents)} label="spent, all-in" />
        </section>
      )}

      {entries.length === 0 ? (
        <EmptyState>
          Nothing finished yet. Every change I complete lands here with what it cost and how it turned out &mdash; the
          good and the honest misses.
        </EmptyState>
      ) : (
        <section>
          <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">History</p>
          <div className="space-y-2">
            {entries.map((e) => (
              <Row key={e.cardId} entry={e} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ n, text, label }: { n?: number; text?: string; label: string }) {
  return (
    <div>
      <p className="text-headline font-display text-ink">{text ?? n}</p>
      <p className="text-meta text-ink-quiet">{label}</p>
    </div>
  );
}

function Row({ entry }: { entry: LedgerEntryData }) {
  const edge = entryEdge(entry);
  const when = new Date(entry.at);
  // The drill-down: a finished card's acts, fetched on first expand. Before
  // this, acts became unreachable the moment a card went terminal — the
  // endpoint served them, the record page just never asked.
  const [acts, setActs] = useState<ActView[] | null>(null);
  const loadActs = () => {
    if (acts !== null) return;
    api
      .get<{ card: { acts: ActView[] } }>(`/api/cards/${entry.cardId}`)
      .then((r) => setActs(r.card.acts))
      .catch(() => setActs([]));
  };
  return (
    <div className="relative rounded-card border border-hairline bg-panel px-4 py-3 pl-5">
      <SelvedgeEdge status={edge} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-body text-ink">{entry.intent}</p>
        <span className="flex shrink-0 items-center gap-2 text-meta text-ink-quiet">
          <StatusDot status={edge} />
          {outcomeLabel(entry)}
        </span>
      </div>
      <p className="mt-1 text-meta text-ink-quiet">
        {entry.trigger === 'incident' ? 'I raised this' : 'you asked'} · {formatCents(entry.spentCents)}
        {Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleDateString()}`}
      </p>
      <div onClick={loadActs} className="mt-1">
        <Reveal summary="history">
          {acts === null ? (
            <div className="text-ink-quiet">loading…</div>
          ) : acts.length === 0 ? (
            <div className="text-ink-quiet">no history recorded for this one</div>
          ) : (
            <ol className="space-y-0.5">
              {acts.map((a, i) => (
                <li key={i}>{describeAct(a)}</li>
              ))}
            </ol>
          )}
        </Reveal>
      </div>
    </div>
  );
}
