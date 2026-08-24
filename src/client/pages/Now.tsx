import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeEdge, StatusDot } from '../components/SelvedgeEdge.js';
import { railPlaces, whenShort, type InboxData, type RailPlace } from '../lib/inbox.js';

/** NOW — scheduler and launchpad. State leads; prose and history follow. */
export function Now() {
  const navigate = useNavigate();
  const [data, setData] = useState<InboxData | null>(null);
  const [command, setCommand] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<InboxData>('/api/inbox').then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const places = useMemo(() => railPlaces(data?.projects ?? [], data?.subjects ?? []).filter((p) => !p.putAway), [data]);
  const needs = places.filter((p) => p.status === 'needs');
  const running = places.filter((p) => p.status !== 'needs' && (p.status === 'working' || p.chat?.working));
  const priority = new Set([...needs, ...running].map((p) => p.id));
  const recent = places.filter((p) => !priority.has(p.id)).slice(0, 8);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const text = command.trim();
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      const name = text.length > 56 ? `${text.slice(0, 53)}…` : text;
      const made = await api.post<{ subject: { id: string } }>('/api/subjects', { name });
      const opened = await api.post<{ thread: { id: string } }>(`/api/subjects/${made.subject.id}/threads`, { title: name });
      await api.post(`/api/threads/${opened.thread.id}/message`, { text });
      navigate(`/inbox/${opened.thread.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
      setStarting(false);
    }
  }

  return (
    <div className="animate-settle mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex items-baseline justify-between border-b border-hairline pb-work">
        <h1 className="text-headline font-semibold tracking-tight text-ink">NOW</h1>
        <time className="font-mono text-tech uppercase text-ink-quiet">
          {new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' }).format(new Date())}
        </time>
      </header>

      <form onSubmit={(e) => void start(e)} className="mt-read border-b border-hairline bg-panel px-work-loose py-work">
        <div className="flex items-end gap-work">
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={1}
            placeholder="Start or direct work…"
            className="max-h-36 min-h-10 flex-1 resize-none bg-transparent text-lede text-ink outline-none placeholder:text-ink-quiet"
          />
          <button disabled={!command.trim() || starting} className="rounded-inset bg-action px-4 py-2 text-body font-medium text-ink disabled:opacity-40">
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
        <p className="mt-work-tight font-mono text-tech text-ink-quiet">use @ to assign a builder · # to bring in context</p>
      </form>

      {error && <p className="mt-work border-l-2 border-thread pl-work text-body text-thread">{error}</p>}

      <div className="mt-read grid gap-read lg:grid-cols-[1.3fr_.7fr]">
        <div className="space-y-read">
          <WorkGroup title="Needs you" status="needs" places={needs} onOpen={(p) => p.chat && navigate(`/inbox/${p.chat.id}`)} />
          <WorkGroup title="Running" status="working" places={running} onOpen={(p) => p.chat && navigate(`/inbox/${p.chat.id}`)} />
          {!needs.length && !running.length && data && (
            <p className="border-y border-hairline py-read text-body text-ink-dim">No work currently needs intervention or reports itself running.</p>
          )}
        </div>
        <section>
          <p className="mb-work text-label font-semibold uppercase tracking-widest text-ink-quiet">Recent</p>
          <div className="border-t border-hairline">
            {recent.map((place) => <WorkRow key={place.id} place={place} compact onOpen={() => place.chat && navigate(`/inbox/${place.chat.id}`)} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function WorkGroup({ title, status, places, onOpen }: { title: string; status: 'needs' | 'working'; places: RailPlace[]; onOpen: (p: RailPlace) => void }) {
  if (!places.length) return null;
  return (
    <section>
      <p className="mb-work flex items-center gap-work text-label font-semibold uppercase tracking-widest text-ink-quiet">
        <StatusDot status={status} /> {title} · {places.length}
      </p>
      <div className="border-t border-hairline">{places.map((place) => <WorkRow key={place.id} place={place} onOpen={() => onOpen(place)} />)}</div>
    </section>
  );
}

function WorkRow({ place, compact = false, onOpen }: { place: RailPlace; compact?: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} disabled={!place.chat} className="relative flex w-full items-center gap-work border-b border-hairline py-work-loose pl-work text-left hover:bg-panel-soft disabled:cursor-default">
      {place.status && <SelvedgeEdge status={place.status} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-work">
          <strong className="truncate text-body font-medium text-ink">{place.name}</strong>
          {place.chat && <time className="font-mono text-tech text-ink-quiet">{whenShort(place.chat.last_at)}</time>}
        </span>
        {!compact && <span className="block truncate text-meta text-ink-dim">{place.chat?.title ?? place.health ?? 'No active thread'}</span>}
        {!compact && place.chat?.working && <span className="mt-1 block font-mono text-tech uppercase text-brass">working now</span>}
      </span>
      {place.chat && <AgentChip agent={place.chat.agent} working={place.chat.working} />}
    </button>
  );
}
