import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { StatusDot } from '../components/SelvedgeEdge.js';
import { PROJECT_STATE_ACTION, PROJECT_STATE_LABEL, projectState, railPlaces, whenShort, type InboxData, type RailPlace } from '../lib/inbox.js';

/**
 * HOME is the project shelf, not a second workbench and not a generic prompt
 * launcher. It answers three questions with state Selvedge already has:
 * what needs me, what is moving, and where was I last.
 *
 * Deliberately absent: generated thumbnails, an invented context score, agent
 * recommendations, and another project-memory model. Those all require truth
 * the current payload cannot supply. The existing compiler remains the thing
 * that catches an agent up when the owner enters the workbench.
 */
export function Now() {
  const navigate = useNavigate();
  const composer = useRef<HTMLTextAreaElement>(null);
  const firstName = (window as { Clerk?: { user?: { firstName?: string | null } } }).Clerk?.user?.firstName?.trim();
  const [data, setData] = useState<InboxData | null>(null);
  const [command, setCommand] = useState('');
  // `null` means the project list has not been initialized yet. An empty
  // string is a real, user-selected value: start a new idea with no project.
  // Keeping those states distinct prevents the default-project effect from
  // immediately undoing a deliberate "New idea" selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [continuationAvailable, setContinuationAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<InboxData>('/api/inbox').then(setData).catch((e: Error) => setError(e.message));
    api.get<{ available: boolean }>('/api/continuations/availability').then((v) => setContinuationAvailable(v.available)).catch(() => setContinuationAvailable(false));
  }, []);

  const places = useMemo(() => railPlaces(data?.projects ?? [], data?.subjects ?? []).filter((place) => !place.putAway), [data]);
  const projects = places.filter((place) => place.hasCode);
  const subjects = places.filter((place) => !place.hasCode);
  const needs = projects.filter((place) => projectState(place) === 'needs_you');
  const moving = projects.filter((place) => projectState(place) === 'changing');
  const review = projects.filter((place) => projectState(place) === 'ready_to_review');
  const rest = projects.filter((place) => !needs.includes(place) && !moving.includes(place) && !review.includes(place));
  const selected = places.find((place) => place.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && places[0]) setSelectedId(places[0].id);
  }, [places, selectedId]);

  function startHere(place: RailPlace) {
    if (place.chat) {
      navigate(`/inbox/${place.chat.id}`);
      return;
    }
    setSelectedId(place.id);
    composer.current?.focus();
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const text = command.trim();
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      let threadId: string;
      if (selected) {
        if (selected.chat) threadId = selected.chat.id;
        else {
          const endpoint = selected.hasCode ? `/api/projects/${encodeURIComponent(selected.id)}/threads` : `/api/subjects/${encodeURIComponent(selected.id)}/threads`;
          const opened = await api.post<{ thread: { id: string } }>(endpoint, { title: text.slice(0, 80) });
          threadId = opened.thread.id;
        }
      } else {
        const name = text.length > 56 ? `${text.slice(0, 53)}…` : text;
        const made = await api.post<{ subject: { id: string } }>('/api/subjects', { name });
        const opened = await api.post<{ thread: { id: string } }>(`/api/subjects/${made.subject.id}/threads`, { title: name });
        threadId = opened.thread.id;
      }
      await api.post(`/api/threads/${threadId}/message`, { text });
      navigate(`/inbox/${threadId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't go through.");
      setStarting(false);
    }
  }

  return (
    <div className="home-surface animate-settle mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
      <header className="max-w-4xl">
        <h1 className="font-display text-[clamp(2.25rem,5vw,4rem)] font-normal leading-[1.04] tracking-[-0.045em] text-ink">
          Which project are you working on today{firstName ? `, ${firstName}` : ''}?
        </h1>
      </header>

      <main className="mt-9 grid items-start gap-8 lg:grid-cols-[minmax(0,.82fr)_minmax(0,1.18fr)] xl:gap-10">
        <div className="space-y-5 lg:sticky lg:top-8">
        <form onSubmit={(e) => void start(e)} className="rounded-pane bg-panel p-5 shadow-[0_18px_55px_rgba(26,58,40,0.07)] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-display text-2xl font-normal text-ink">Start something</h2><p className="mt-1 text-meta text-ink-dim">Choose its home. Selvedge brings the project context and current builder.</p></div>
            <select aria-label="Choose a project" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)} className="rounded-full bg-panel-soft px-4 py-2 text-body text-ink outline-none focus:ring-2 focus:ring-action-bright">
              {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
              <option value="">New idea</option>
            </select>
          </div>
          <textarea ref={composer} value={command} onChange={(e) => setCommand(e.target.value)} rows={3} aria-label="What should we work on?" placeholder="What should we work on?" className="mt-5 w-full resize-none rounded-card bg-paper-soft px-4 py-3 text-[16px] leading-relaxed text-ink outline-none placeholder:text-ink-quiet focus:ring-2 focus:ring-action-bright" />
          <div className="mt-3 flex items-center justify-between gap-4"><span className="text-meta text-ink-quiet">One project · every builder · shared context</span><button disabled={!command.trim() || starting} className="rounded-full bg-deep px-5 py-2.5 text-body font-medium text-white disabled:opacity-35">{starting ? 'Starting…' : 'Start →'}</button></div>
          {error && <p role="alert" className="mt-3 text-body text-thread">{error}</p>}
        </form>

        {continuationAvailable && (
          <div className="rounded-pane bg-sage p-5 sm:p-6">
            <strong className="block text-body-lg text-ink">Already building somewhere else?</strong><p className="mt-1 text-body text-ink-dim">Bring the project and its AI conversation. Continue without explaining it all again.</p>
            <button type="button" onClick={() => navigate('/continue')} className="mt-4 rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">Continue a project →</button>
          </div>
        )}

        <aside className="rounded-pane bg-sage p-6">
          <p className="text-meta font-semibold text-action-bright">The Selvedge promise</p>
          <p className="mt-3 font-display text-2xl leading-snug text-ink">Your project gets better as AI gets better.</p>
          <p className="mt-3 text-body leading-relaxed text-ink-dim">Switch builders or return months later. The project stays whole and its context is ready.</p>
        </aside>
        </div>

        <div className="min-w-0">
          {projects.length > 0 ? (
            <div className="space-y-10">
              {needs.length > 0 && <ProjectGroup title="Needs you" places={needs} onOpen={startHere} />}
              {moving.length > 0 && <ProjectGroup title="In progress" places={moving} onOpen={startHere} />}
              {review.length > 0 && <ProjectGroup title="Ready to review" places={review} onOpen={startHere} />}
              {rest.length > 0 && <ProjectGroup title={needs.length || moving.length || review.length ? 'Other active projects' : 'Active projects'} places={rest} onOpen={startHere} />}
            </div>
          ) : data ? (
            <section className="rounded-pane bg-panel p-7 shadow-[0_18px_55px_rgba(26,58,40,0.07)] sm:p-9">
              <h2 className="font-display text-3xl font-normal text-ink">Give your work a home.</h2>
              <p className="mt-3 max-w-xl text-body-lg text-ink-dim">Connect an existing repository or bring over a project from Replit. Its conversations, decisions, changes, and releases stay together from then on.</p>
              <div className="mt-6 flex flex-wrap gap-3"><Link to="/migrate" className="rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">Bring in a project</Link><Link to="/projects" className="rounded-full bg-panel-soft px-5 py-2.5 text-body font-medium text-ink">Connect GitHub</Link></div>
            </section>
          ) : null}

          {subjects.length > 0 && (
            <section className="mt-10">
              <div className="mb-4"><h2 className="font-display text-2xl font-normal text-ink">Ideas and conversations</h2><p className="mt-1 text-meta text-ink-dim">Work that does not belong to a codebase yet.</p></div>
              <div className="flex flex-wrap gap-2">{subjects.map((subject) => <button key={subject.id} onClick={() => startHere(subject)} className="rounded-full bg-panel px-4 py-2 text-body text-ink shadow-[0_8px_24px_rgba(26,58,40,0.05)] hover:bg-panel-soft">{subject.name}</button>)}</div>
            </section>
          )}
        </div>
      </main>

    </div>
  );
}

function ProjectGroup({ title, places, onOpen }: { title: string; places: RailPlace[]; onOpen: (place: RailPlace) => void }) {
  return (
    <section aria-label={title}>
      <div className="mb-4 flex items-baseline justify-between gap-4"><h2 className="font-display text-2xl font-normal text-ink">{title}</h2><span className="text-meta text-ink-quiet">{places.length} {places.length === 1 ? 'project' : 'projects'}</span></div>
      <div className="grid gap-4 sm:grid-cols-2">{places.map((place) => <HomeProject key={place.id} place={place} onOpen={() => onOpen(place)} />)}</div>
    </section>
  );
}

function HomeProject({ place, onOpen }: { place: RailPlace; onOpen: () => void }) {
  const state = projectState(place);
  return (
    <button onClick={onOpen} className="group min-h-44 rounded-pane bg-panel p-5 text-left shadow-[0_12px_36px_rgba(26,58,40,0.055)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_46px_rgba(26,58,40,0.09)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright">
      <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2 rounded-full bg-panel-soft px-3 py-1 text-meta text-ink-dim">{place.status && <StatusDot status={place.status} />}{PROJECT_STATE_LABEL[state]}</span>{place.chat && <span className="text-meta text-ink-quiet">{whenShort(place.chat.last_at)}</span>}</div>
      <h3 className="mt-5 truncate font-display text-[1.45rem] font-normal text-ink">{place.name}</h3>
      <p className="mt-2 line-clamp-2 text-body text-ink-dim">{place.chat?.title ?? 'Open this project and start with its context already attached.'}</p>
      <div className="mt-5 flex items-center justify-between gap-3"><span className="text-meta font-medium text-action-bright">{place.chat ? `${PROJECT_STATE_ACTION[state]} →` : 'Start here →'}</span>{place.chat && <AgentChip agent={place.chat.agent} working={place.chat.working} />}</div>
    </button>
  );
}
