import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { WorkCard } from '../components/WorkCard.js';
import { needsOwner, type WorkCardData, type CardState } from '../lib/card.js';
import type { ProjectCardData } from '../components/ProjectRail.js';

/**
 * The work surface — every change the loop is walking, the owner's side of it.
 * Cards that need a decision come first (proposals and checkpoint pauses); then
 * what's in motion; then what's finished. The whole thesis in one screen: you
 * are asked, never surprised, and nothing spends past what you approved.
 */

const TERMINAL = new Set<CardState>(['done', 'declined', 'stopped', 'failed']);

export function Work() {
  const [cards, setCards] = useState<WorkCardData[] | null>(null);
  const [projects, setProjects] = useState<ProjectCardData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api.get<{ cards: WorkCardData[] }>('/api/cards').then((r) => setCards(r.cards)),
      api.get<ProjectCardData[]>('/api/projects').then(setProjects),
    ]).catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!cards) return <p className="text-body text-ink-quiet">Loading…</p>;

  const attention = cards.filter((c) => needsOwner(c.state));
  const inFlight = cards.filter((c) => !needsOwner(c.state) && !TERMINAL.has(c.state));
  const finished = cards.filter((c) => TERMINAL.has(c.state));

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Work</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">Make a quick change without opening the Workshop.</p>
      </div>

      {projects.length > 0 && <AskForChange projects={projects} onCreated={() => void load()} />}

      {cards.length === 0 && (
        <p className="text-body text-ink-quiet">
          Nothing on the bench yet — ask for a change above, or I'll raise one the moment something breaks that I can fix.
        </p>
      )}

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

/**
 * Ask for a change — the owner-initiated front of the loop. Plain words in; a
 * proposal card out. Risk is decided on the server from what the change touches
 * (never here), so this stays a simple text box: describe it, and the card comes
 * back with its estimate, stop-point, and — if it's sensitive — its gate.
 */
function AskForChange({ projects, onCreated }: { projects: ProjectCardData[]; onCreated: () => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.project_id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/cards`, { text: text.trim() });
      setText('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-3 rounded-card border border-hairline bg-panel p-4">
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Ask for a change</p>
      <div className="flex flex-wrap gap-3">
        {projects.length > 1 && (
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. make the gift note optional at checkout"
          className="min-w-[16rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || text.trim().length === 0 || projectId === ''}
          className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy ? 'Scoping…' : 'Propose it'}
        </button>
        <span className="text-meta text-ink-quiet">You'll see the cost and approve before anything ships.</span>
        {error && <span className="text-meta text-thread">{error}</span>}
      </div>
    </form>
  );
}
