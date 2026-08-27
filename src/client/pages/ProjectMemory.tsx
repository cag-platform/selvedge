import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ContextPack } from '../../shared/types/pack.js';
import { PROJECT_STATE_ACTION, PROJECT_STATE_LABEL, projectState, railPlaces, type InboxData } from '../lib/inbox.js';
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
  const place = inbox ? railPlaces(inbox.projects, inbox.subjects).find((item) => item.id === projectId) ?? null : null;
  const state = place ? projectState(place) : null;
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
    <div className="min-h-[calc(100vh-var(--nav-height))] bg-paper-soft">
      <div className="mx-auto max-w-6xl px-5 pb-20 pt-9 sm:px-8 sm:pt-12">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link to="/" className="text-meta text-ink-quiet hover:text-action-bright">← Home</Link>
            <h1 className="mt-3 font-display text-[clamp(2.7rem,6vw,5rem)] font-normal leading-none tracking-[-0.05em] text-ink">{memory.name}</h1>
            <p className="mt-4 max-w-2xl text-body-lg leading-relaxed text-ink-dim">{memory.summary}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <span className="rounded-full bg-panel px-4 py-2 text-meta text-ink-dim shadow-sm"><strong className="font-medium text-ink">{state ? PROJECT_STATE_LABEL[state] : health?.label}</strong>{health?.detail ? ` · ${health.detail}` : ''}</span>
            <Link to={builder ? `/inbox/${builder.id}` : `/inbox/project/${projectId}`} className="rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">{state ? PROJECT_STATE_ACTION[state] : 'Open workbench'} →</Link>
          </div>
        </header>

        <div className="mt-10 grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,.65fr)]">
          <main className="space-y-5">
            <section className="rounded-pane bg-panel p-6 shadow-[0_14px_40px_rgba(26,58,40,0.06)] sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div>
                  <p className="text-meta font-semibold text-action-bright">Current work</p>
                  <h2 className="mt-2 font-display text-3xl font-normal text-ink">{builder?.title ?? 'Ready for its next conversation'}</h2>
                  <p className="mt-3 max-w-2xl text-body leading-relaxed text-ink-dim">{builder ? `${builder.agent} is the most recent builder. Every agent entering this project receives its accepted decisions, current evidence, and open questions.` : 'The first builder starts with this project’s existing context already attached.'}</p>
                </div>
                {builder && <AgentChip agent={builder.agent} working={builder.working} />}
              </div>
            </section>

            <section aria-labelledby="context-title" className="rounded-pane bg-sage p-6 sm:p-8">
              <div className="mb-6"><p className="text-meta font-semibold text-action-bright">Known already</p><h2 id="context-title" className="mt-2 font-display text-3xl font-normal text-ink">What every AI starts with</h2></div>
              <div className="grid gap-3 sm:grid-cols-2">
                {categories.map((category) => (
                  <div key={category.label} className="rounded-card bg-panel p-5">
                    <div className="flex items-baseline justify-between gap-4"><h3 className="text-body font-semibold text-ink">{category.label}</h3><span className="text-meta text-ink-quiet">{category.count}</span></div>
                    <p className="mt-4 line-clamp-3 text-body leading-relaxed text-ink-dim">{category.hint}</p>
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="history-title" className="rounded-pane bg-panel p-6 shadow-[0_14px_40px_rgba(26,58,40,0.05)] sm:p-8">
              <div className="mb-6"><p className="text-meta font-semibold text-action-bright">Project history</p><h2 id="history-title" className="mt-2 font-display text-3xl font-normal text-ink">What happened here</h2></div>
              <TimelineTab projectId={projectId} onOpenThread={(threadId) => navigate(`/inbox/${threadId}`)} />
            </section>
          </main>

          <aside aria-label="Project details" className="space-y-4">
            <section className="rounded-pane bg-panel p-5 shadow-[0_10px_30px_rgba(26,58,40,0.045)]">
              <p className="text-meta font-semibold text-action-bright">What governs the work</p>
              <p className="mt-3 text-body leading-relaxed text-ink">{governing || 'No governing decision has been recorded yet.'}</p>
              <p className="mt-5 text-meta text-ink-quiet">Strongest recent evidence</p>
              <p className="mt-2 text-body leading-relaxed text-ink-dim">{evidence || 'The record does not contain supporting evidence yet.'}</p>
            </section>

            <section className="rounded-pane bg-panel p-5 shadow-[0_10px_30px_rgba(26,58,40,0.045)]">
              <p className="text-meta font-semibold text-action-bright">Open questions · {context.sections.open.length}</p>
              {context.sections.open.length ? <ul className="mt-3 space-y-3">{context.sections.open.map((item, index) => <li key={index} className="text-body leading-relaxed text-ink">{item}</li>)}</ul> : <p className="mt-3 text-body text-ink-dim">Nothing is waiting on you right now.</p>}
            </section>

            <section className="rounded-pane bg-panel p-5 shadow-[0_10px_30px_rgba(26,58,40,0.045)]">
              <p className="text-meta font-semibold text-action-bright">Project controls</p>
              <div className="mt-4 grid gap-3 text-body">
                {context.project.repo && <a href={context.project.repo} target="_blank" rel="noopener noreferrer" className="text-action-bright hover:underline">Open repository ↗</a>}
                <Link to={`/projects/${projectId}/edit`} className="text-action-bright hover:underline">Project settings</Link>
                <Link to="/admin/context" className="text-action-bright hover:underline">Import context</Link>
                <a href="/api/export" download className="text-action-bright hover:underline">Export memory</a>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
