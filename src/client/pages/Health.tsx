import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ProjectCard, type ProjectCardData } from '../components/ProjectRail.js';
import { SituationCard, type SituationEvent } from '../components/SituationCard.js';

type Correction = { id: string; project_id: string | null; line: string };
type StatusResponse = { corrections: Correction[]; live: SituationEvent[] };

/**
 * A watch floor, not an analytics dashboard. This is the sole reader of
 * /api/status because reading a correction acknowledges it.
 */
export function Health() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<StatusResponse>('/api/status'), api.get<ProjectCardData[]>('/api/projects')])
      .then(([nextStatus, nextProjects]) => { setStatus(nextStatus); setProjects(nextProjects); })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const visible = useMemo(() => (projects ?? []).filter((project) => !project.muted), [projects]);
  const attention = visible.filter((project) => project.edge === 'needs' || project.review_ready);
  const watched = visible.filter((project) => !attention.includes(project));
  const events = (status?.live ?? []).filter((event) => event.projectId !== null || event.eventType === 'connector.auth_failed');

  return (
    <div className="home-surface animate-settle mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
      <header className="flex flex-col gap-5 border-b border-hairline pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-label font-semibold uppercase tracking-widest text-action-bright">Health center</p>
          <h1 className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-normal leading-[1.04] tracking-[-0.045em] text-ink">Your projects, looked after.</h1>
          <p className="mt-4 max-w-2xl text-body-lg leading-relaxed text-ink-dim">Production, builds, releases, and the signals Selvedge can actually see—without pretending silence means healthy.</p>
        </div>
        <Link to="/admin/connections" className="shrink-0 text-body font-medium text-action-bright hover:underline">Manage connections →</Link>
      </header>

      {error && <p role="alert" className="mt-8 rounded-card bg-panel px-4 py-3 text-body text-thread">{error}</p>}

      {status?.corrections.length ? (
        <section aria-label="Corrections" className="mt-8 rounded-pane border border-hairline border-l-4 border-l-thread bg-panel p-6">
          <p className="text-label font-semibold uppercase tracking-widest text-thread">Correcting myself</p>
          {status.corrections.map((correction) => <p key={correction.id} className="mt-2 text-body-lg text-ink">{correction.line}</p>)}
        </section>
      ) : null}

      {projects && projects.length === 0 && (
        <section className="mt-10 rounded-pane bg-panel p-7">
          <h2 className="font-display text-3xl text-ink">Nothing to watch yet.</h2>
          <p className="mt-3 max-w-xl text-body-lg text-ink-dim">Bring in a project, then connect the places it runs. Selvedge will only report what it can verify.</p>
          <Link to="/projects" className="mt-6 inline-block rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">Bring in a project</Link>
        </section>
      )}

      {attention.length > 0 && <ProjectSection title="Needs your attention" projects={attention} tone="attention" />}

      {events.length > 0 && (
        <section className="mt-12">
          <div className="mb-4"><h2 className="font-display text-2xl text-ink">What changed</h2><p className="mt-1 text-meta text-ink-dim">Recent verified events across your projects.</p></div>
          <div className="grid gap-3 lg:grid-cols-2">{events.map((event) => <SituationCard key={event.id} event={event} />)}</div>
        </section>
      )}

      {projects && attention.length === 0 && events.length === 0 && projects.length > 0 && (
        <section className="mt-10 rounded-pane bg-sage p-7">
          <p className="text-label font-semibold uppercase tracking-widest text-healthy">Quiet right now</p>
          <h2 className="mt-3 font-display text-3xl text-ink">Nothing needs you.</h2>
          <p className="mt-2 text-body-lg text-ink-dim">That means no current signal requires attention—not that Selvedge can see everything.</p>
        </section>
      )}

      {watched.length > 0 && <ProjectSection title="Under watch" projects={watched} />}
    </div>
  );
}

function ProjectSection({ title, projects, tone }: { title: string; projects: ProjectCardData[]; tone?: 'attention' }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div><h2 className="font-display text-2xl text-ink">{title}</h2><p className="mt-1 text-meta text-ink-dim">Open a project to see its record and connected services.</p></div>
        <span className={`text-meta ${tone ? 'text-thread' : 'text-ink-quiet'}`}>{projects.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{projects.map((project) => <ProjectCard key={project.project_id} project={project} />)}</div>
    </section>
  );
}
