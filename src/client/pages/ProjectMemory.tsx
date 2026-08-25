import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ContextPack } from '../../shared/types/pack.js';
import type { InboxData } from '../lib/inbox.js';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { TimelineTab } from '../components/TimelineTab.js';

type Learned = { plain: string; times_seen: number; last_confirmed: string; possibly_stale: boolean };
type Memory = {
  project_id: string;
  name: string;
  learned_signatures: Learned[];
  deploy_cadence: string | null;
  known_flaky: Array<{ pattern: string; note?: string }>;
  glossary: Array<{ term: string; means: string }>;
  summary: string;
};
type ProjectContext = {
  project: { id: string; name: string; repo: string | null };
  sections: { about: string[]; recent: string[]; open: string[] };
};

function freshness(memory: Memory, pack: ContextPack): { label: string; detail: string } {
  const latest = memory.learned_signatures.map((item) => item.last_confirmed).sort().at(-1);
  if (latest) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(latest).getTime()) / 86_400_000));
    return days > 45
      ? { label: 'Needs a fresh signal', detail: `Last confirmed ${days} days ago` }
      : { label: 'Memory is current', detail: days === 0 ? 'Confirmed today' : `Confirmed ${days} day${days === 1 ? '' : 's'} ago` };
  }
  const trust = pack.trust?.overall_confidence;
  return trust
    ? { label: trust === 'high' ? 'Memory is grounded' : 'Memory is still forming', detail: `${trust} source confidence` }
    : { label: 'Memory is still forming', detail: 'The next observed change will strengthen it' };
}

export function ProjectMemory() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<Memory>(`/api/projects/${encodeURIComponent(projectId)}/memory`),
      api.get<ProjectContext>(`/api/projects/${encodeURIComponent(projectId)}/context`),
      api.get<ContextPack>(`/api/packs/${encodeURIComponent(projectId)}`),
      api.get<InboxData>('/api/inbox'),
    ])
      .then(([nextMemory, nextContext, nextPack, nextInbox]) => {
        setMemory(nextMemory);
        setContext(nextContext);
        setPack(nextPack);
        setInbox(nextInbox);
      })
      .catch((err: Error) => setError(err.message));
  }, [projectId]);

  const project = inbox?.projects.find((item) => item.id === projectId);
  const builder = project?.threads[0] ?? null;
  const health = useMemo(() => (memory && pack ? freshness(memory, pack) : null), [memory, pack]);
  const governing = context?.sections.about[0] ?? pack?.identity.owner_description ?? null;
  const evidence = context?.sections.recent[0] ?? null;

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <p role="alert" className="text-body text-thread">Project memory could not be opened: {error}</p>
        <Link to="/projects" className="mt-4 inline-block text-action-bright hover:underline">Back to projects</Link>
      </div>
    );
  }

  if (!memory || !context || !pack) {
    return <div className="mx-auto max-w-6xl px-4 py-16 text-body text-ink-quiet" aria-live="polite">Gathering project memory…</div>;
  }

  const categories = [
    { label: 'Observed behavior', count: memory.learned_signatures.length, hint: memory.learned_signatures[0]?.plain ?? 'Still learning from the work' },
    { label: 'Supporting evidence', count: context.sections.recent.length, hint: context.sections.recent[0] ?? 'No recent evidence recorded' },
    { label: 'Accepted language', count: memory.glossary.length, hint: memory.glossary[0] ? `${memory.glossary[0].term} means ${memory.glossary[0].means}` : 'No project terms accepted yet' },
    { label: 'Open questions', count: context.sections.open.length, hint: context.sections.open[0] ?? 'Nothing currently waiting' },
  ];

  return (
    <div className="min-h-[calc(100vh-var(--nav-height))] bg-paper">
      <header className="border-b border-hairline bg-panel-soft/70">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="section-label">Project memory · {memory.name}</p>
              <h1 className="mt-3 max-w-3xl font-display text-[clamp(2.7rem,7vw,5.75rem)] leading-[0.94] tracking-[-0.045em] text-ink">
                The work remembers.
              </h1>
              <p className="mt-5 max-w-2xl text-body-lg leading-relaxed text-ink-dim">
                Decisions, evidence, language, and unfinished questions remain with {memory.name} as conversations, tools, and builders change.
              </p>
            </div>
            <div className="rounded-card border border-hairline bg-panel px-4 py-3">
              <p className="text-body font-medium text-ink">{health?.label}</p>
              <p className="mt-0.5 text-meta capitalize text-ink-quiet">{health?.detail}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.75fr)]">
        <div className="space-y-6">
          <section aria-labelledby="memory-map-title" className="overflow-hidden rounded-[1.75rem] bg-deep p-6 text-[var(--paper)] shadow-pane sm:p-9">
            <p className="text-label uppercase tracking-[0.16em] text-[color:var(--action)]">Durable context</p>
            <h2 id="memory-map-title" className="mt-2 font-display text-[clamp(2rem,4.5vw,3.8rem)] leading-tight">What this project knows</h2>
            <p className="mt-3 max-w-2xl text-body leading-relaxed text-[color:var(--paper-dim)]">{memory.summary}</p>
            <div className="mt-10 grid gap-px overflow-hidden rounded-card bg-white/15 sm:grid-cols-2">
              {categories.map((category) => (
                <div key={category.label} className="min-h-40 bg-[color:var(--action-deep)] p-5">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="font-display text-xl">{category.label}</h3>
                    <span className="font-mono text-meta text-[color:var(--action)]">{category.count}</span>
                  </div>
                  <p className="mt-8 line-clamp-3 text-body leading-relaxed text-[color:var(--paper-dim)]">{category.hint}</p>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="history-title" className="rounded-[1.5rem] border border-hairline bg-panel p-5 sm:p-7">
            <div className="mb-6">
              <p className="section-label">Relevant project history</p>
              <h2 id="history-title" className="mt-1 font-display text-3xl text-ink">How the understanding formed</h2>
            </div>
            <TimelineTab projectId={projectId} onOpenThread={(threadId) => navigate(`/inbox/${threadId}`)} />
          </section>
        </div>

        <aside aria-label="Project understanding" className="space-y-4">
          <section className="rounded-card border border-hairline bg-panel p-5">
            <p className="section-label">What governs the work</p>
            <h2 className="mt-3 font-display text-2xl text-ink">Governing understanding</h2>
            <p className="mt-3 text-body leading-relaxed text-ink">{governing || 'No governing decision has been recorded yet.'}</p>
            <div className="mt-5 border-t border-hairline pt-4">
              <p className="text-label uppercase tracking-widest text-ink-quiet">Strongest recent evidence</p>
              <p className="mt-2 text-body leading-relaxed text-ink-dim">{evidence || 'The record does not contain supporting evidence yet.'}</p>
            </div>
          </section>

          <section className="rounded-card border border-hairline bg-sage p-5">
            <p className="section-label">Current builder</p>
            {builder ? (
              <>
                <div className="mt-3 flex items-center gap-3">
                  <AgentChip agent={builder.agent} working={builder.working} />
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-ink">{builder.agent}</p>
                    <p className="text-meta text-ink-dim">{builder.working ? 'Working now' : 'Most recent builder'}</p>
                  </div>
                </div>
                <p className="mt-4 text-body leading-relaxed text-ink-dim">
                  {context.sections.about.length + context.sections.recent.length + context.sections.open.length} grounded context lines transfer with the project.
                </p>
                <Link to={`/inbox/${builder.id}`} className="mt-4 inline-block text-body font-medium text-action-bright hover:underline">
                  Open workbench →
                </Link>
              </>
            ) : (
              <p className="mt-3 text-body text-ink-dim">No builder is attached. The first conversation will inherit this project context.</p>
            )}
          </section>

          <section className="rounded-card border border-hairline bg-panel p-5">
            <p className="section-label">Accepted language</p>
            {memory.glossary.length ? (
              <dl className="mt-3 space-y-3">
                {memory.glossary.map((item) => (
                  <div key={item.term}>
                    <dt className="text-body font-medium text-ink">{item.term}</dt>
                    <dd className="text-body text-ink-dim">{item.means}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="mt-3 text-body text-ink-dim">No preferred terms have been established yet.</p>}
          </section>

          <section className="rounded-card border border-hairline bg-panel p-5">
            <p className="section-label">Open questions · {context.sections.open.length}</p>
            {context.sections.open.length ? (
              <ul className="mt-3 space-y-3">
                {context.sections.open.map((item, index) => <li key={index} className="text-body leading-relaxed text-ink">{item}</li>)}
              </ul>
            ) : <p className="mt-3 text-body text-ink-dim">Nothing is waiting on the owner right now.</p>}
          </section>

          <section className="rounded-card border border-hairline bg-panel p-5">
            <p className="section-label">Portability</p>
            <p className="mt-3 text-body leading-relaxed text-ink-dim">The record belongs to you. Bring context in or take the complete memory with you.</p>
            <div className="mt-4 flex flex-wrap gap-4 text-body">
              <Link to="/admin/context" className="text-action-bright hover:underline">Import context</Link>
              <a href="/api/export" download className="text-action-bright hover:underline">Export memory</a>
              <Link to={`/projects/${projectId}/edit`} className="text-ink-dim hover:underline">Project settings</Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
