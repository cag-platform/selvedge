import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  budgetNote,
  canBuild,
  sketchStatus,
  type SketchCost,
  type SketchData,
  type SketchListItem,
  type SketchMessageData,
} from '../lib/sketch.js';
import { btnPrimary, eyebrowCls, inputCls, labelCls } from '../components/ui.js';

/**
 * Sketch — the cheap room next door to the workshop.
 *
 * Talk an idea through with something that already knows what your app is and
 * how it's been behaving. Nothing here touches code, a sandbox, or the live
 * app: it's thinking, and thinking costs pennies. When the idea is clear it
 * writes the brief, and one button hands that to the workshop — so the
 * expensive part runs once, on a well-formed instruction.
 */

type SketchView = { sketch: SketchData; thread: SketchMessageData[]; cost: SketchCost; available?: boolean; questions?: string[] };
type ProjectOption = { project_id: string; name: string };

/** Shared composer shell: grows with the paragraph, Enter sends, Shift+Enter newlines. */
function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder,
  submitLabel,
  busyLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
  submitLabel: string;
  busyLabel: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && value.trim() !== '') onSubmit();
      }}
      className="flex items-end gap-2"
    >
      <textarea
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            form.current?.requestSubmit();
          }
        }}
        rows={1}
        disabled={busy}
        placeholder={placeholder}
        className="max-h-56 min-h-[2.5rem] flex-1 resize-none overflow-y-auto rounded-inset border border-hairline bg-panel-soft px-3 py-2 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-60"
      />
      <button type="submit" disabled={busy || value.trim() === ''} className={btnPrimary}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}

/** The list: every idea, freshest first. */
export function Sketches() {
  const [items, setItems] = useState<SketchListItem[] | null>(null);
  const [cost, setCost] = useState<SketchCost | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api
      .get<{ sketches: SketchListItem[]; cost: SketchCost }>('/api/sketches')
      .then((d) => {
        setItems(d.sketches);
        setCost(d.cost);
      })
      .catch((e: Error) => setError(e.message));
    void api
      .get<ProjectOption[]>('/api/projects')
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<SketchView>('/api/sketches', {
        text: text.trim(),
        ...(projectId ? { project_id: projectId } : {}),
      });
      navigate(`/sketch/${created.sketch.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  }

  if (error && !items) return <p className="text-body text-thread">{error}</p>;

  const note = cost ? budgetNote(cost) : null;

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Sketch</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">
          Think an idea through before anything gets built. Nothing here touches your app — it's just thinking, and
          thinking is cheap. When it's clear, hand it to the Workshop.
        </p>
        {note && <p className="mt-1 text-meta text-ink-quiet">Thinking spend: {note}</p>}
      </div>

      <div className="max-w-xl space-y-3 rounded-card border border-hairline bg-panel p-4">
        {projects.length > 0 && (
          <label className={labelCls}>
            What's it about? <span className="text-ink-quiet">(optional)</span>
            <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Not sure yet</option>
              {projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={() => void start()}
          busy={busy}
          placeholder="What are you thinking about?"
          submitLabel="Start thinking"
          busyLabel="Thinking…"
        />
        {error && <p className="text-meta text-thread">{error}</p>}
      </div>

      {items && items.length > 0 && (
        <div className="space-y-3">
          <p className={eyebrowCls}>Ideas</p>
          {items.map((s) => (
            <Link
              key={s.id}
              to={`/sketch/${s.id}`}
              className="block rounded-card border border-hairline bg-panel p-4 transition-colors duration-settle ease-settle hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-body text-ink">{s.title}</span>
                <span className={`shrink-0 text-meta ${s.ready && !s.handed_off_at ? 'text-action-bright' : 'text-ink-quiet'}`}>
                  {sketchStatus(s)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** One idea, being talked through. */
export function SketchThread() {
  const { sketchId } = useParams();
  const [data, setData] = useState<SketchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [buildIn, setBuildIn] = useState('');
  const [handing, setHanding] = useState(false);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    if (!sketchId) return Promise.resolve();
    return api
      .get<SketchView>(`/api/sketches/${sketchId}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [sketchId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api
      .get<ProjectOption[]>('/api/projects')
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.thread.length]);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!data) return <p className="text-body text-ink-quiet">Loading…</p>;

  async function send() {
    if (!sketchId) return;
    setBusy(true);
    setError(null);
    try {
      // Answers synchronously — a model call takes seconds, so there's nothing
      // to poll for and no spinner to babysit.
      setData(await api.post<SketchView>(`/api/sketches/${sketchId}/messages`, { text: text.trim() }));
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  }

  async function handOff() {
    if (!sketchId || !data) return;
    const target = data.sketch.project_id ?? buildIn;
    if (!target) {
      setHandoffNote('Pick which project this should be built in.');
      return;
    }
    setHanding(true);
    setHandoffNote(null);
    try {
      await api.post(`/api/sketches/${sketchId}/handoff`, { project_id: target });
      navigate(`/projects/${target}/workshop`);
    } catch (e) {
      setHandoffNote(e instanceof Error ? e.message : 'that did not reach the workshop');
    } finally {
      setHanding(false);
    }
  }

  const note = budgetNote(data.cost);
  const buildable = canBuild(data.sketch);

  return (
    <div className="animate-settle space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={eyebrowCls}>
            <Link to="/sketch" className="hover:text-ink-dim">
              Sketch
            </Link>
          </p>
          <h1 className="truncate text-display font-display font-medium text-ink">{data.sketch.title}</h1>
        </div>
        {note && <p className="text-meta text-ink-quiet">Thinking spend: {note}</p>}
      </header>

      {data.available === false && (
        <p className="rounded-card border border-hairline bg-panel-soft px-4 py-3 text-body text-ink-dim">
          No AI model is connected yet, so I can't think this through with you. Connect one on{' '}
          <Link to="/connections" className="text-action-bright hover:underline">
            Connections
          </Link>
          . Everything else about your projects is unaffected.
        </p>
      )}

      <section className="flex min-h-[24rem] flex-col rounded-card border border-hairline bg-panel">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: '34rem' }}>
          {data.thread.map((m) => (
            <div key={m.id} className={m.role === 'owner' ? 'pl-6' : 'border-l-2 border-hairline pl-3'}>
              <p className={eyebrowCls}>{m.role === 'owner' ? 'You' : 'Selvedge'}</p>
              <p className="whitespace-pre-line text-body text-ink">{m.content}</p>
            </div>
          ))}
          {busy && (
            <div className="border-l-2 border-brass pl-3">
              <p className={eyebrowCls}>Selvedge</p>
              <p className="text-body text-ink-dim">
                Thinking<span className="animate-pulse">…</span>
              </p>
            </div>
          )}
          <div ref={threadEnd} />
        </div>
        <div className="border-t border-hairline p-3">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void send()}
            busy={busy}
            placeholder="What are you thinking?"
            submitLabel="Send"
            busyLabel="Thinking…"
          />
          {error && <p className="mt-2 text-meta text-thread">{error}</p>}
        </div>
      </section>

      {buildable && (
        <div className="space-y-3 rounded-card border border-hairline border-l-2 border-l-action-bright bg-panel-soft px-4 py-3">
          <p className={eyebrowCls}>The brief</p>
          <p className="whitespace-pre-line text-body text-ink">{data.sketch.brief}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {data.sketch.project_id ? (
              <span className="text-meta text-ink-quiet">
                {data.sketch.handed_off_at ? 'Already sent to the Workshop once.' : 'Ready when you are.'}
              </span>
            ) : (
              <label className="flex items-center gap-2 text-meta text-ink-dim">
                Build it in
                <select
                  className="rounded-inset border border-hairline bg-panel px-2 py-1 text-meta text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
                  value={buildIn}
                  onChange={(e) => setBuildIn(e.target.value)}
                >
                  <option value="">choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button disabled={handing} onClick={() => void handOff()} className={btnPrimary}>
              {handing ? 'Sending…' : 'Build this in the Workshop'}
            </button>
          </div>
          {handoffNote && <p className="text-meta text-thread">{handoffNote}</p>}
        </div>
      )}
    </div>
  );
}
