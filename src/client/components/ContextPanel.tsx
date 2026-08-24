import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { TimelineTab } from './TimelineTab.js';
import { btnPrimary, EmptyState, ContextSkeleton } from './ui.js';
import { formatCents } from '../lib/ledger.js';
import { inMotion, stateLabel, type WorkCardData } from '../lib/card.js';
import type { ConsoleLink, ThreadData } from '../lib/inbox.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { PreviewEnv } from './PreviewEnv.js';

/**
 * THE CONTEXT PANEL — what is true about the project this thread belongs to,
 * beside the conversation rather than instead of it.
 *
 * Three tabs, and three is the point. It carried four, one of which (Work) was
 * a list of things that were not about the conversation you were having — and
 * the cards that DID want you sat in a panel that is closed by default on a
 * laptop. Those are folded into the thread now, where approving happens.
 *
 * What is left answers three questions, in the order people ask them:
 *   Now      — what is true this minute: the app, and what is in motion.
 *   History  — what has happened to this project.
 *   About    — what Selvedge understands it to be, and how to correct that.
 *
 * These are not places you go: they are context for the thread in focus.
 * Collapsible, and collapsed by default on a narrow screen: on a laptop the
 * conversation matters more than the panel.
 */

type Tab = 'now' | 'timeline' | 'pack';
type Preview = {
  state: 'ready' | 'none' | 'error';
  url: string | null;
  message: string | null;
  /**
   * Something the owner could turn on that would plausibly fix this. Set only
   * when the failure actually points at it, so the offer arrives at the moment
   * it is relevant rather than as a setting nobody goes looking for.
   */
  offer?: 'database' | 'env';
};

function LiveApp({ data, onReload }: { data: ThreadData & { project: { id: string; name: string } }; onReload: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Opened by the failure that needs it, and stays open afterwards so a second
  // variable can go in without hunting for the link again.
  const [envOpen, setEnvOpen] = useState(false);

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
          <p className="text-body text-ink-dim">This isn’t online yet — only you can see it.</p>
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
            {/*
              THE ANSWER TO THE SENTENCE ABOVE, next to it.
              An app that stopped because it wanted a database is one tap from
              having one — and the tap belongs here, beside the explanation,
              not in a settings screen the reader would have to go find.
            */}
            {!busy && preview?.offer === 'database' && (
              <button
                className="mt-2 block text-meta text-action-bright hover:underline"
                onClick={async () => {
                  setNote(null);
                  try {
                    await api.put(`/api/projects/${data.project.id}/preview-database`, { enabled: true });
                    await load();
                  } catch (e) {
                    setNote(e instanceof Error ? e.message : 'that did not work');
                  }
                }}
              >
                Give it a database and try again
              </button>
            )}
            {/*
              The other answer to the other sentence. The diagnosis has already
              named the variable it wants; opening the box here means the fix is
              where the problem was said, rather than in a settings screen the
              reader has to go and find while holding a stack trace in their head.
            */}
            {!busy && preview?.offer === 'env' && !envOpen && (
              <button className="mt-2 block text-meta text-action-bright hover:underline" onClick={() => setEnvOpen(true)}>
                Add the environment it needs
              </button>
            )}
          </p>
        )}
        {envOpen && (
          <div className="px-work pb-work">
            <PreviewEnv projectId={data.project.id} onSaved={() => void load()} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * WHAT IS IN MOTION — running, not waiting. Work that needs you is folded into
 * the thread instead, because a decision belongs where the conversation is,
 * and this panel is closed by default on a laptop.
 *
 * Each line carries what it has spent against what it may spend, because
 * "working on it" without a figure is exactly the shape of a surprise.
 */
function InMotion({ projectId }: { projectId: string }) {
  const [cards, setCards] = useState<WorkCardData[] | null>(null);

  useEffect(() => {
    api
      .get<{ cards: WorkCardData[] }>(`/api/cards?project=${encodeURIComponent(projectId)}`)
      .then((r) => setCards(r.cards.filter((c) => inMotion(c.state))))
      .catch(() => setCards([]));
  }, [projectId]);

  return (
    <div className="space-y-work-tight">
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">In motion</p>
      {cards === null ? (
        <ContextSkeleton />
      ) : cards.length === 0 ? (
        <EmptyState>No work in flight. Ask for a change in the conversation and the card appears here.</EmptyState>
      ) : (
        <ul className="space-y-work-tight">
          {cards.map((card) => (
            <li key={card.id} className="flex items-baseline justify-between gap-work border-l-2 border-brass pl-work">
              <span className="min-w-0 truncate text-body text-ink">{card.title}</span>
              <span className="shrink-0 font-mono text-tech text-ink-quiet">
                {stateLabel(card.state, card.verdict).toLowerCase()} · {formatCents(card.spentCents)} of {formatCents(card.stop.capCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PackTab({ projectId, doors }: { projectId: string; doors: ConsoleLink[] }) {
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
      {/* THE ACCOUNTS BEHIND THIS — the Railway variables, the database
          console, the repo — as doors rather than inert mono lines. The URLs
          are the server's (connectors/consoles.ts): the client only opens
          them, so the phone and the web can never disagree about where a
          door leads. No secret is in a URL; the provider's own session
          decides whether the door opens. */}
      {doors.length > 0 && (
        <ul className="space-y-1">
          {doors.map((door) => (
            <li key={door.url}>
              <a
                href={door.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
              >
                {door.provider} — {door.label} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      {/* Sources with no console we know: still named, as data rather than a
          door, so the list never understates what the project runs on. */}
      {pack.topology.sources.filter((s) => !doors.some((d) => d.provider.toLowerCase() === s.connector)).length > 0 && (
        <ul className="font-mono text-tech text-ink-quiet">
          {pack.topology.sources
            .filter((s) => !doors.some((d) => d.provider.toLowerCase() === s.connector))
            .map((s) => (
              <li key={`${s.connector}:${s.resource_id}`}>
                {s.connector} · {s.resource_id}
              </li>
            ))}
        </ul>
      )}
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
  // A subject's thread has no project behind it, so it has no work cards, no
  // app to preview and no pack — the panel simply isn't shown for one.
  const project = data.project;
  const [tab, setTab] = useState<Tab>('now');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'now', label: 'Now' },
    { id: 'timeline', label: 'History' },
    { id: 'pack', label: 'About' },
  ];
  if (!project) return null;

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
        {tab === 'now' && (
          <div className="space-y-work-loose">
            {/* Only a building thread has a workshop to look at. A talking one
                still has work in motion and a project that may be online. */}
            {data.thread.kind === 'workshop' ? (
              <LiveApp data={{ ...data, project }} onReload={onReload} />
            ) : (
              data.live_url && (
                <p className="text-body text-ink">
                  Online at{' '}
                  <a href={data.live_url} target="_blank" rel="noopener noreferrer" className="text-action-bright hover:underline">
                    {data.live_url.replace(/^https:\/\//, '')}
                  </a>
                </p>
              )
            )}
            <InMotion projectId={project.id} />
          </div>
        )}
        {tab === 'timeline' && <TimelineTab projectId={project.id} onOpenThread={onOpenThread} />}
        {tab === 'pack' && <PackTab projectId={project.id} doors={data.console_links ?? []} />}
      </div>
    </aside>
  );
}
