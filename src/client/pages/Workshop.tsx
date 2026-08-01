import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCents } from '../lib/ledger.js';

/**
 * The workshop — where a project gets fixed, changed, and iterated on, in plain
 * English. Left: the conversation with the agent. Right: the app, live, running
 * in the project's sandbox. The cost watch sits in the header, always visible.
 *
 * Nothing here touches the live app: everything happens in the sandbox until
 * shipping (which arrives with its own gates). Walking away is free — the
 * sandbox stops itself after 15 idle minutes.
 */

type Message = { id: string; role: 'owner' | 'agent' | 'activity'; content: string; at: string };
type WorkshopData = {
  project: { id: string; name: string };
  engine_on: boolean;
  working: boolean;
  staged_changes_ready: boolean;
  sandbox: 'attached' | 'none';
  thread: Message[];
  runs: Array<{ id: string; status: string; cost_cents: number | null; commit: string | null; kind: 'ship' | 'turn'; at: string }>;
  cost: { today_cents: number; month_cents: number };
};
type Preview = { state: 'ready' | 'none' | 'error'; url: string | null; message: string | null };

/**
 * Ship controls: one button when work is staged. A sensitive change (the server
 * judges the actual changed files) comes back asking for a backup confirmation;
 * the checkbox appears and the same button ships it. The last ship carries its
 * undo — a real revert, one click.
 */
function ShipControls({ projectId, working, lastShipCommit, onDone }: { projectId: string; working: boolean; lastShipCommit: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [needsBackup, setNeedsBackup] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function ship() {
    setBusy(true);
    setNote(null);
    try {
      await api.post(`/api/projects/${projectId}/workshop/ship`, { backup_confirmed: backupConfirmed });
      setNeedsBackup(false);
      setBackupConfirmed(false);
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'that did not go through';
      if (/backup/i.test(message)) {
        setNeedsBackup(true);
        setNote(message);
      } else {
        setNote(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastShipCommit) return;
    setBusy(true);
    setNote(null);
    try {
      await api.post(`/api/projects/${projectId}/workshop/rollback`, { commit: lastShipCommit });
      onDone();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'the undo did not go through');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-card border border-hairline border-l-2 border-l-action-bright bg-panel-soft px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-ink">There's finished work here that isn't live yet.</p>
        <div className="flex items-center gap-2">
          {lastShipCommit && (
            <button disabled={busy} onClick={() => void undo()} className="text-meta text-ink-quiet hover:text-thread disabled:opacity-50">
              Undo last ship
            </button>
          )}
          <button
            disabled={busy || working || (needsBackup && !backupConfirmed)}
            onClick={() => void ship()}
            className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            {busy ? 'Shipping…' : 'Ship it'}
          </button>
        </div>
      </div>
      {needsBackup && (
        <label className="flex items-start gap-2 text-meta text-ink-dim">
          <input type="checkbox" className="mt-0.5" checked={backupConfirmed} onChange={(e) => setBackupConfirmed(e.target.checked)} />
          <span>I have a recent backup I could restore from.</span>
        </label>
      )}
      {note && <p className="text-meta text-ink-dim">{note}</p>}
    </div>
  );
}

export function Workshop() {
  const { projectId } = useParams();
  const [data, setData] = useState<WorkshopData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const wasWorking = useRef(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return api
      .get<WorkshopData>(`/api/projects/${projectId}/workshop`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  const loadPreview = useCallback(async () => {
    if (!projectId) return;
    setPreviewBusy(true);
    try {
      setPreview(await api.get<Preview>(`/api/projects/${projectId}/workshop/preview`));
    } catch (e) {
      setPreview({ state: 'error', url: null, message: e instanceof Error ? e.message : 'preview failed' });
    } finally {
      setPreviewBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the agent works (3s), gently otherwise (12s). When a turn
  // finishes, refresh the preview so what you see is what it just did.
  useEffect(() => {
    const interval = setInterval(() => void load(), data?.working ? 3000 : 12000);
    return () => clearInterval(interval);
  }, [data?.working, load]);

  useEffect(() => {
    if (wasWorking.current && data && !data.working) void loadPreview();
    wasWorking.current = data?.working ?? false;
  }, [data, loadPreview]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.thread.length]);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!data) return <p className="text-body text-ink-quiet">Loading…</p>;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || text.trim() === '') return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/workshop/message`, { text: text.trim() });
      setText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="animate-settle space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">
            <Link to="/projects" className="hover:text-ink-dim">Projects</Link> · Workshop
          </p>
          <h1 className="text-display font-display font-medium text-ink">{data.project.name}</h1>
        </div>
        <div className="text-right">
          {/* The cost watch — always visible, never a surprise bill. */}
          <p className="text-meta text-ink-dim">
            Spent here: <span className="text-ink">{formatCents(data.cost.today_cents)}</span> today ·{' '}
            <span className="text-ink">{formatCents(data.cost.month_cents)}</span> this month
          </p>
          <p className="text-meta text-ink-quiet">
            {data.sandbox === 'attached' ? 'Workshop is warm — it pauses itself after 15 quiet minutes.' : 'Workshop is cold — it wakes when you ask for something.'}
          </p>
        </div>
      </header>

      {!data.engine_on && (
        <p className="rounded-card border border-hairline bg-panel-soft px-4 py-3 text-body text-ink-dim">
          The workshop isn't switched on yet — the build engine's credentials aren't configured. Everything else about
          this project (the watching, the brief) is unaffected.
        </p>
      )}

      {data.staged_changes_ready && projectId && (
        <ShipControls
          projectId={projectId}
          working={data.working}
          lastShipCommit={data.runs.find((r) => r.kind === 'ship' && r.commit)?.commit ?? null}
          onDone={() => void load()}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* The conversation */}
        <section className="flex min-h-[28rem] flex-col rounded-card border border-hairline bg-panel">
          <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: '32rem' }}>
            {data.thread.length === 0 && (
              <p className="text-body text-ink-quiet">
                Say what you want in plain words — "make the header dark", "fix the broken checkout button", "add a
                simple contact form". I'll do it here in the workshop, and you'll see it on the right before anything
                goes live.
              </p>
            )}
            {data.thread.map((m) =>
              m.role === 'activity' ? (
                // The live work feed: what the agent is actually doing, line by
                // line, updating in place while the turn runs.
                <div key={m.id} className="border-l-2 border-hairline pl-3">
                  <p className="whitespace-pre-line font-mono text-tech text-ink-quiet">{m.content}</p>
                </div>
              ) : (
                <div key={m.id} className={m.role === 'owner' ? 'pl-6' : 'border-l-2 border-hairline pl-3'}>
                  <p className="text-label font-body uppercase tracking-widest text-ink-quiet">
                    {m.role === 'owner' ? 'You' : 'Selvedge'}
                  </p>
                  <p className="whitespace-pre-line text-body text-ink">{m.content}</p>
                </div>
              ),
            )}
            {data.working && (
              <div className="border-l-2 border-brass pl-3">
                <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge</p>
                <p className="text-body text-ink-dim">
                  Working on it<span className="animate-pulse">…</span>
                </p>
              </div>
            )}
            <div ref={threadEnd} />
          </div>
          <form onSubmit={send} className="flex gap-2 border-t border-hairline p-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={sending || data.working || !data.engine_on}
              placeholder={data.working ? 'Working — one thing at a time…' : 'What should change?'}
              className="flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-2 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={sending || data.working || !data.engine_on || text.trim() === ''}
              className="rounded-inset bg-action px-4 py-2 text-body font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Do it'}
            </button>
          </form>
        </section>

        {/* The app, live */}
        <section className="flex min-h-[28rem] flex-col rounded-card border border-hairline bg-panel">
          <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
            <p className="text-label font-body uppercase tracking-widest text-ink-quiet">The app, live in the workshop</p>
            <button
              onClick={() => void loadPreview()}
              disabled={previewBusy}
              className="text-meta text-ink-quiet hover:text-ink-dim disabled:opacity-50"
            >
              {previewBusy ? 'Waking it…' : preview?.state === 'ready' ? 'Refresh' : 'Show the app'}
            </button>
          </div>
          <div className="flex-1">
            {preview?.state === 'ready' && preview.url ? (
              <iframe
                key={preview.url}
                src={preview.url}
                title="App preview"
                className="h-full min-h-[26rem] w-full rounded-b-card bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            ) : (
              <div className="flex h-full min-h-[26rem] items-center justify-center p-6">
                <p className="max-w-xs text-center text-body text-ink-quiet">
                  {previewBusy
                    ? 'Waking the workshop and starting the app — this can take a minute the first time.'
                    : preview?.message ?? 'Press "Show the app" to see it running — changes appear here as they happen, before anything ships.'}
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
