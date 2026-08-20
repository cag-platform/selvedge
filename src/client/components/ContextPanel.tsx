import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { WorkCard } from './WorkCard.js';
import { TimelineTab } from './TimelineTab.js';
import { btnPrimary } from './ui.js';
import type { WorkCardData } from '../lib/card.js';
import type { ThreadData } from '../lib/inbox.js';
import type { ContextPack } from '../../shared/types/pack.js';

/**
 * THE CONTEXT PANEL — what is true about the project this thread belongs to,
 * beside the conversation rather than instead of it.
 *
 * These are not places you go: they are context for the thread in focus. The
 * work cards, the app running in the sandbox, and what Selvedge understands
 * about the project — the same pack the brief and the agent read, shown here so
 * "what does it think this app is?" is answerable without leaving the work.
 *
 * Collapsible, and collapsed by default on a narrow screen: on a laptop the
 * conversation matters more than the panel.
 */

type Tab = 'work' | 'preview' | 'timeline' | 'pack';
type Preview = { state: 'ready' | 'none' | 'error'; url: string | null; message: string | null };

function PreviewTab({ data, onReload }: { data: ThreadData; onReload: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setPreview(await api.get<Preview>(`/api/projects/${data.project.id}/workshop/preview`));
    } catch (e) {
      setPreview({ state: 'error', url: null, message: e instanceof Error ? e.message : 'preview failed' });
    } finally {
      setBusy(false);
    }
  }, [data.project.id]);

  // When a turn finishes, what you are looking at is out of date — refresh it
  // so the preview shows what the agent just did.
  useEffect(() => {
    if (!data.working && preview?.state === 'ready') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.working]);

  async function goLive() {
    setBusy(true);
    setNote(null);
    try {
      await api.post(`/api/projects/${data.project.id}/workshop/golive`, {});
      setNote("Setting it up — I'll say how it goes on the thread. This takes a few minutes.");
      onReload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-work">
      {data.live_url ? (
        <p className="text-body text-ink">
          Online at{' '}
          <a href={data.live_url} target="_blank" rel="noopener noreferrer" className="text-action-bright hover:underline">
            {data.live_url.replace(/^https:\/\//, '')}
          </a>
        </p>
      ) : (
        <div className="space-y-work-tight">
          <p className="text-body text-ink-dim">This isn't online yet — only you can see it.</p>
          <button disabled={busy} onClick={() => void goLive()} className={btnPrimary}>
            {busy ? 'Starting…' : 'Put it online'}
          </button>
          {note && <p className="text-meta text-ink-quiet">{note}</p>}
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-hairline bg-panel">
        <div className="flex items-center justify-between border-b border-hairline px-work py-work-tight">
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">The app, live in the workshop</p>
          <button onClick={() => void load()} disabled={busy} className="text-meta text-ink-quiet hover:text-ink-dim disabled:opacity-50">
            {busy ? 'Waking it…' : preview?.state === 'ready' ? 'Refresh' : 'Show the app'}
          </button>
        </div>
        {preview?.state === 'ready' && preview.url ? (
          <iframe
            key={preview.url}
            src={preview.url}
            title="App preview"
            className="h-96 w-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        ) : (
          <p className="p-work text-body text-ink-quiet">
            {busy ? 'Waking the workshop and starting the app — this can take a minute the first time.' : preview?.message ?? 'Press "Show the app" to see it running.'}
          </p>
        )}
      </div>
    </div>
  );
}

function WorkTab({ projectId }: { projectId: string }) {
  const [cards, setCards] = useState<WorkCardData[] | null>(null);
  const load = useCallback(() => {
    api
      .get<{ cards: WorkCardData[] }>(`/api/cards?project=${encodeURIComponent(projectId)}`)
      .then((r) => setCards(r.cards))
      .catch(() => setCards([]));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!cards) return <p className="text-body text-ink-quiet">Loading…</p>;
  if (cards.length === 0) return <p className="text-body text-ink-quiet">No cards on this project — every ask that becomes work turns up here.</p>;
  return (
    <div className="space-y-work">
      {cards.map((card) => (
        <WorkCard key={card.id} card={card} onChanged={load} />
      ))}
    </div>
  );
}

function PackTab({ projectId }: { projectId: string }) {
  const [pack, setPack] = useState<ContextPack | null>(null);
  useEffect(() => {
    api
      .get<ContextPack>(`/api/packs/${encodeURIComponent(projectId)}`)
      .then(setPack)
      .catch(() => setPack(null));
  }, [projectId]);

  if (!pack) return <p className="text-body text-ink-quiet">Nothing understood about this project yet.</p>;
  return (
    <div className="space-y-work text-body text-ink-dim">
      <p className="text-ink">{pack.identity.owner_description}</p>
      {pack.stakes.downtime_translation && <p>If it breaks: {pack.stakes.downtime_translation}</p>}
      {pack.topology.stack_summary && <p className="font-mono text-tech text-ink-quiet">{pack.topology.stack_summary}</p>}
      <ul className="font-mono text-tech text-ink-quiet">
        {pack.topology.sources.map((s) => (
          <li key={`${s.connector}:${s.resource_id}`}>
            {s.connector} · {s.resource_id}
          </li>
        ))}
      </ul>
      <p>
        <Link to={`/projects/${projectId}/edit`} className="text-action-bright hover:underline">
          Correct what I understand
        </Link>{' '}
        — this is the same note the brief and the agent read.
      </p>
    </div>
  );
}

export function ContextPanel({
  data,
  onReload,
  onClose,
  onOpenThread,
}: {
  data: ThreadData;
  onReload: () => void;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(data.thread.kind === 'workshop' ? 'preview' : 'work');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'work', label: 'Work' },
    ...(data.thread.kind === 'workshop' ? ([{ id: 'preview', label: 'Preview' }] as Array<{ id: Tab; label: string }>) : []),
    { id: 'timeline', label: 'History' },
    { id: 'pack', label: 'Pack' },
  ];

  return (
    <aside aria-label="Context" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-hairline px-work py-work-tight">
        <div className="flex gap-work-tight">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'true' : undefined}
              className={`rounded-inset px-work py-work-tight text-meta focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
                tab === t.id ? 'bg-panel-soft text-ink' : 'text-ink-quiet hover:text-ink-dim'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} title="Hide this panel (Esc)" className="text-meta text-ink-quiet hover:text-ink-dim">
          Hide
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-work">
        {tab === 'work' && <WorkTab projectId={data.project.id} />}
        {tab === 'preview' && <PreviewTab data={data} onReload={onReload} />}
        {tab === 'timeline' && <TimelineTab projectId={data.project.id} onOpenThread={onOpenThread} />}
        {tab === 'pack' && <PackTab projectId={data.project.id} />}
      </div>
    </aside>
  );
}
