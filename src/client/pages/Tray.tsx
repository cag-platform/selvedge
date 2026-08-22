import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { SelvedgeEdge } from '../components/SelvedgeEdge.js';
import { Pane, btnPrimary, inputCls, eyebrowCls } from '../components/ui.js';

type Source = {
  connector: string;
  resource_id: string;
  label: string;
  is_repo: boolean;
  count: number;
  last_seen: string;
};
type IgnoredSource = { connector: string; resource_id: string; label: string; is_repo: boolean };
type SourcesResponse = { sources: Source[]; ignored: IgnoredSource[] };
type ProjectOption = { project_id: string; name: string };

const keyOf = (s: { connector: string; resource_id: string }) => `${s.connector}:${s.resource_id}`;

/**
 * YOUR APPS — the settings page that answers "what has Selvedge seen, and
 * where does it belong?".
 *
 * This was the "Unsorted" tab in the main navigation, which put a filing job
 * on the same footing as the work itself. Worse, it showed an opaque id and
 * offered exactly one answer — "this belongs to an existing project" — so a
 * repo you hadn't set up yet, and anything that simply wasn't yours, sat there
 * forever. A tray that only grows stops being read.
 *
 * Three answers now, and the row says which repo it is, because for GitHub the
 * id always was the repository's full name:
 *   Watch it        — make a project from this repo (the missing one)
 *   Part of …       — file it under a project you already have
 *   Ignore          — not mine; stop asking, including about what arrives later
 *
 * Calm, not an error ("The Look"): the dashed unknown edge, plain words, one
 * press to teach it. It never asks twice.
 */
export function Tray() {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.get<SourcesResponse>('/api/tray/sources').then(setData).catch(() => setData({ sources: [], ignored: [] }));
  }, []);

  useEffect(() => {
    refresh();
    api.get<ProjectOption[]>('/api/projects').then(setProjects).catch(() => undefined);
  }, [refresh]);

  async function act(source: Source | IgnoredSource, path: string, body: Record<string, unknown> = {}) {
    setBusy(keyOf(source));
    setNote(null);
    try {
      const res = await api.post<{ name?: string }>(path, {
        connector: source.connector,
        resource_id: source.resource_id,
        ...body,
      });
      if (res.name) setNote(`${res.name} is a project now — everything from ${source.label} is on it.`);
      refresh();
      // A new project changes what "Part of…" can offer.
      api.get<ProjectOption[]>('/api/projects').then(setProjects).catch(() => undefined);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "that didn't go through");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <p className="text-body text-ink-quiet">Loading…</p>;

  return (
    <div className="animate-settle space-y-4">
      {note && <p className="text-body text-ink-dim">{note}</p>}

      {data.sources.length === 0 ? (
        <Pane className="p-6">
          <p className="text-body-lg text-ink">Nothing unplaced — everything I've seen has a home.</p>
          <p className="mt-1 text-body text-ink-dim">
            When something arrives that I can't place, it waits here quietly. Telling me once is enough.
          </p>
        </Pane>
      ) : (
        <>
          <p className={eyebrowCls}>Things I've seen · tell me once where they belong</p>
          <div className="space-y-3">
            {data.sources.map((source) => (
              <Pane key={keyOf(source)} className="space-y-work pl-5">
                <SelvedgeEdge status="unknown" />
                <div>
                  {/* The repo, said as a repo. This was an opaque id. */}
                  <p className="font-mono text-tech text-ink">{source.label}</p>
                  <p className="text-meta text-ink-dim">
                    {source.is_repo ? 'a GitHub repository' : source.connector} · {source.count} thing
                    {source.count === 1 ? '' : 's'} I noticed but can't place yet
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* The answer that didn't exist, and the likeliest true one
                      for a repo you own — so it goes first. */}
                  {source.is_repo && (
                    <button
                      className={btnPrimary}
                      disabled={busy === keyOf(source)}
                      onClick={() => void act(source, '/api/tray/watch')}
                    >
                      Watch it as its own project
                    </button>
                  )}
                  <label className="sr-only" htmlFor={`assign-${keyOf(source)}`}>
                    Which project does {source.label} belong to?
                  </label>
                  <select
                    id={`assign-${keyOf(source)}`}
                    className={`${inputCls} mt-0 w-52`}
                    value={choice[keyOf(source)] ?? ''}
                    onChange={(e) => {
                      const projectId = e.target.value;
                      setChoice((c) => ({ ...c, [keyOf(source)]: projectId }));
                      if (projectId) void act(source, '/api/tray/assign', { project_id: projectId });
                    }}
                  >
                    <option value="">Part of a project I have…</option>
                    {projects.map((p) => (
                      <option key={p.project_id} value={p.project_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-meta text-ink-quiet underline hover:text-ink-dim disabled:opacity-50"
                    disabled={busy === keyOf(source)}
                    onClick={() => void act(source, '/api/tray/ignore')}
                  >
                    Not mine — stop asking
                  </button>
                </div>
              </Pane>
            ))}
          </div>
        </>
      )}

      {/* Ignoring is undoable, and visibly so: a dismissal you can't find
          again is indistinguishable from something quietly lost. */}
      {data.ignored.length > 0 && (
        <div className="space-y-work-tight">
          <p className={eyebrowCls}>Ignored · I don't ask about these</p>
          <ul className="space-y-1">
            {data.ignored.map((source) => (
              <li key={keyOf(source)} className="flex flex-wrap items-baseline gap-work text-meta text-ink-quiet">
                <span className="font-mono text-tech">{source.label}</span>
                <button
                  className="underline hover:text-ink-dim disabled:opacity-50"
                  disabled={busy === keyOf(source)}
                  onClick={() => void act(source, '/api/tray/unignore')}
                >
                  start asking again
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
