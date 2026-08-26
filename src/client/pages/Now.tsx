import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { StatusDot } from '../components/SelvedgeEdge.js';
import { railPlaces, whenShort, type InboxData } from '../lib/inbox.js';

type ProjectMemory = {
  project_id: string; name: string;
  learned_signatures: Array<{ plain: string; possibly_stale: boolean }>;
  known_flaky: Array<{ pattern: string }>;
  glossary: Array<{ term: string; means: string }>;
  summary: string;
};

/** HOME — begin with intent, then make the project boundary visible. */
export function Now() {
  const navigate = useNavigate();
  const [data, setData] = useState<InboxData | null>(null);
  const [command, setCommand] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectionLocked, setSelectionLocked] = useState(false);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [starting, setStarting] = useState(false);
  const [continuationAvailable, setContinuationAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<InboxData>('/api/inbox').then(setData).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => { api.get<{ available: boolean }>('/api/continuations/availability').then((v) => setContinuationAvailable(v.available)).catch(() => setContinuationAvailable(false)); }, []);
  const places = useMemo(() => railPlaces(data?.projects ?? [], data?.subjects ?? []).filter((p) => !p.putAway), [data]);
  const selected = places.find((p) => p.id === selectedId) ?? null;

  useEffect(() => { if (places.length && !selectedId) setSelectedId(places[0]!.id); }, [places, selectedId]);
  useEffect(() => {
    if (selectionLocked) return;
    const words = command.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (!words.length) return;
    const match = places.find((place) => words.some((word) => `${place.name} ${place.chat?.title ?? ''}`.toLowerCase().includes(word)));
    if (match) setSelectedId(match.id);
  }, [command, places, selectionLocked]);
  useEffect(() => {
    if (!selected?.hasCode) { setMemory(null); return; }
    let live = true;
    api.get<ProjectMemory>(`/api/projects/${encodeURIComponent(selected.id)}/memory`).then((v) => live && setMemory(v)).catch(() => live && setMemory(null));
    return () => { live = false; };
  }, [selected?.id, selected?.hasCode]);

  const needs = places.filter((p) => p.status === 'needs');
  const running = places.filter((p) => p.status !== 'needs' && (p.status === 'working' || p.chat?.working));
  const recent = places.filter((p) => !needs.includes(p) && !running.includes(p)).slice(0, 3);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const text = command.trim();
    if (!text || starting) return;
    setStarting(true); setError(null);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through."); setStarting(false);
    }
  }

  const contextCount = memory ? memory.learned_signatures.length + memory.known_flaky.length + memory.glossary.length : selected?.chat ? 1 : 0;

  return (
    <div className="animate-settle mx-auto max-w-5xl px-5 pb-20 pt-[clamp(4rem,10vh,7.5rem)] sm:px-8">
      <header className="text-center">
        <p className="font-mono text-label font-semibold uppercase tracking-[0.16em] text-action">Your work, ready when you are</p>
        <h1 className="mt-5 font-display text-[clamp(2.9rem,6.6vw,4.8rem)] font-normal leading-[0.98] tracking-[-0.055em] text-ink">What should we move forward?</h1>
        <p className="mx-auto mt-4 max-w-xl text-lede text-ink-dim">Start with the outcome. Selvedge will bring the right project memory and builder.</p>
      </header>

      {continuationAvailable && <div className="mx-auto mt-8 max-w-3xl rounded-card border border-action/30 bg-sage p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div><strong className="block text-body-lg text-ink">Already building somewhere else?</strong><p className="mt-1 text-body text-ink-dim">Bring an existing project and AI conversation. Continue without explaining it all again.</p></div>
        <button type="button" onClick={() => navigate('/continue')} className="mt-4 shrink-0 rounded-inset bg-action px-4 py-2 text-body font-medium text-ink sm:mt-0">Continue a project →</button>
      </div>}

      <form onSubmit={(e) => void start(e)} className="mx-auto mt-10 max-w-3xl rounded-pane border border-hairline bg-panel p-5 shadow-[0_22px_60px_rgba(26,58,40,0.08)] focus-within:border-action">
        <textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={3} aria-label="Describe what you want to move forward" placeholder="Describe an outcome, ask a question, or drop in a rough idea…" className="w-full resize-none bg-transparent text-[17px] leading-relaxed text-ink outline-none placeholder:text-ink-quiet" />
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <label className="context-chip context-chip-selected"><span aria-hidden>◆</span><span className="sr-only">Store this work in</span>
            <select aria-label="Store this work in" value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setSelectionLocked(true); }} className="max-w-44 bg-transparent text-inherit outline-none">
              {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
              {places.length ? <option value="__new__">New subject</option> : <option value="">New subject</option>}
            </select>
          </label>
          <span className="context-chip">{contextCount ? `${contextCount} memory items attached` : 'Project context attached'}</span>
          <span className="context-chip">Agent routing · Auto</span>
          <button disabled={!command.trim() || starting} aria-label="Start work" className="ml-auto grid h-10 w-10 place-items-center rounded-[11px] bg-deep text-lg text-white transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-35">{starting ? '·' : '↑'}</button>
        </div>
      </form>

      <p className={`mx-auto mt-3 max-w-[46rem] px-2 text-meta text-ink-dim transition-opacity ${command.trim() ? 'opacity-100' : 'opacity-0'}`} aria-live="polite">
        {selected ? <>Selvedge will continue in <strong className="text-ink">{selected.name}</strong> with the project’s current decisions, evidence, and language.</> : selectedId === '__new__' ? 'This will begin in a new subject and keep what the work learns there.' : 'This will begin in a new subject because no existing project is available.'}
      </p>
      {error && <p role="alert" className="mx-auto mt-3 max-w-3xl border-l-2 border-thread pl-3 text-body text-thread">{error}</p>}

      <div className="mx-auto mt-4 grid max-w-3xl gap-2 sm:grid-cols-3">
        <Suggestion title="Synthesize the signal" detail="Recent work → decisions, with evidence" onPick={() => setCommand(`Turn the latest work in ${selected?.name ?? 'this project'} into three decisions, with evidence.`)} />
        <Suggestion title="Continue the work" detail={selected?.chat?.title ?? 'Resume from current project memory'} onPick={() => setCommand(`Continue ${selected?.chat?.title ?? 'the most important unfinished work'}.`)} />
        <Suggestion title="Find the gap" detail="Ask what the project still needs" onPick={() => setCommand(`What is the biggest unanswered question in ${selected?.name ?? 'this work'}?`)} />
      </div>

      <section className="mx-auto mt-16 grid max-w-3xl gap-10 md:grid-cols-[1.25fr_.75fr]">
        <div><p className="section-label">Continue the work</p>
          {[...needs, ...running, ...recent].slice(0, 3).map((place) => (
            <button key={place.id} onClick={() => place.chat && navigate(`/inbox/${place.chat.id}`)} disabled={!place.chat} className="flex w-full items-center justify-between gap-4 border-t border-hairline py-4 text-left disabled:cursor-default">
              <span className="min-w-0"><strong className="block truncate text-body font-semibold text-ink">{place.chat?.title ?? place.name}</strong><small className="mt-1 block truncate text-meta text-ink-quiet">{place.name}{place.chat ? ` · ${whenShort(place.chat.last_at)}` : ''}</small></span>
              <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-panel-soft px-3 py-1.5 text-meta text-ink-dim">{place.status && <StatusDot status={place.status} />}{place.chat?.working ? <><AgentChip agent={place.chat.agent} working /> working</> : place.status === 'needs' ? 'Needs you' : 'Ready'}</span>
            </button>
          ))}
          {!places.length && <p className="border-t border-hairline py-4 text-body text-ink-dim">Your first outcome will create a subject and keep everything learned there.</p>}
        </div>
        <aside><p className="section-label">Project memory</p><div className="rounded-card border border-hairline bg-sage p-5">
          <small className="font-mono text-label uppercase tracking-widest text-ink-dim">{selected?.name ?? 'No project yet'}</small>
          <strong className="mt-3 block font-display text-2xl font-normal text-ink">{memory ? `${contextCount} useful memories` : selected ? 'Context ready' : 'Memory starts here'}</strong>
          <p className="mt-2 text-body leading-relaxed text-ink-dim">{memory?.summary ?? (selected ? 'The current thread and project identity will travel with the work.' : 'Start with an outcome; Selvedge will keep what the work learns.')}</p>
          {selected?.hasCode && <button onClick={() => navigate(`/projects/${selected.id}`)} className="mt-4 text-meta font-medium text-action hover:underline">Open project memory →</button>}
        </div></aside>
      </section>
    </div>
  );
}

function Suggestion({ title, detail, onPick }: { title: string; detail: string; onPick: () => void }) {
  return <button type="button" onClick={onPick} className="rounded-card border border-hairline bg-paper-soft p-4 text-left transition-colors hover:border-action hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action"><strong className="block text-body font-semibold text-ink">{title}</strong><span className="mt-1 block text-meta leading-relaxed text-ink-dim">{detail}</span></button>;
}
