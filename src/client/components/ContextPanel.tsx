import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { TimelineTab } from './TimelineTab.js';
import { btnPrimary, EmptyState, ContextSkeleton } from './ui.js';
import { formatCents } from '../lib/ledger.js';
import { inMotion, stateLabel, type WorkCardData } from '../lib/card.js';
import type { ConsoleLink, ThreadData } from '../lib/inbox.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { PreviewEnv } from './PreviewEnv.js';
import { AgentChip } from './AgentChip.js';
import { WorkspacePreview } from './MigrationPreview.js';
import type { PreviewEvidence } from '../../shared/types/previewEvidence.js';

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

export type ContextTab = 'memory' | 'preview' | 'timeline' | 'pack';
type GroundedContext = { sections: { about: string[]; recent: string[]; open: string[] } };
type LearnedMemory = { glossary: Array<{ term: string; means: string }>; learned_signatures: unknown[] };

function MemoryNow({ data, onChangeAgent }: { data: ThreadData & { project: { id: string; name: string } }; onChangeAgent: () => void }) {
  const [context, setContext] = useState<GroundedContext | null>(null);
  const [memory, setMemory] = useState<LearnedMemory | null>(null);
  useEffect(() => {
    Promise.all([
      api.get<GroundedContext>(`/api/projects/${encodeURIComponent(data.project.id)}/context`),
      api.get<LearnedMemory>(`/api/projects/${encodeURIComponent(data.project.id)}/memory`),
    ]).then(([nextContext, nextMemory]) => {
      setContext(nextContext);
      setMemory(nextMemory);
    }).catch(() => undefined);
  }, [data.project.id]);

  if (!context || !memory) return <ContextSkeleton />;
  return (
    <div className="space-y-work">
      <div>
        <p className="section-label">What governs this work</p>
        <p className="mt-2 text-body leading-relaxed text-ink">{context.sections.about[0] ?? 'No governing understanding has been recorded yet.'}</p>
      </div>
      <div className="rounded-card border border-hairline bg-sage p-work">
        <p className="section-label">Current builder</p>
        <div className="mt-2 flex items-center gap-2"><AgentChip agent={data.thread.agent} working={data.working} /><span className="text-body font-medium text-ink">{data.thread.agent}</span></div>
        <button onClick={onChangeAgent} className="mt-3 text-left text-meta font-medium text-action-bright hover:underline">
          Change builder — project context will be preserved
        </button>
      </div>
      <div>
        <p className="section-label">Strongest recent evidence</p>
        <p className="mt-2 text-body leading-relaxed text-ink-dim">{context.sections.recent[0] ?? 'No supporting evidence has landed in the record yet.'}</p>
      </div>
      <div>
        <p className="section-label">Open questions · {context.sections.open.length}</p>
        {context.sections.open.length ? <ul className="mt-2 space-y-2">{context.sections.open.slice(0, 4).map((line, i) => <li key={i} className="text-body leading-relaxed text-ink">{line}</li>)}</ul> : <p className="mt-2 text-body text-ink-dim">Nothing currently waiting.</p>}
      </div>
      <div>
        <p className="section-label">Accepted language · {memory.glossary.length}</p>
        <p className="mt-2 text-body text-ink-dim">{memory.glossary[0] ? `${memory.glossary[0].term} means ${memory.glossary[0].means}` : 'No preferred terminology established yet.'}</p>
      </div>
      <Link to={`/projects/${data.project.id}`} className="inline-block text-body font-medium text-action-bright hover:underline">Open project home →</Link>
    </div>
  );
}
type Preview = {
  state: 'ready' | 'starting' | 'none' | 'error';
  url: string | null;
  message: string | null;
  evidence?: PreviewEvidence | null;
  /**
   * Something the owner could turn on that would plausibly fix this. Set only
   * when the failure actually points at it, so the offer arrives at the moment
   * it is relevant rather than as a setting nobody goes looking for.
   */
  offer?: 'database' | 'env';
};

function PreviewEvidencePanel({ projectId, evidence }: { projectId: string; evidence: PreviewEvidence }) {
  return <div className="border-t border-hairline p-work"><div className="flex items-center justify-between gap-3"><strong className="text-body text-ink">Independent browser check</strong><span className={`font-mono text-tech ${evidence.status === 'passed' ? 'text-healthy' : evidence.status === 'failed' ? 'text-thread' : 'text-ink-quiet'}`}>{evidence.status}</span></div>{evidence.screenshots.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{evidence.screenshots.map((shot) => <figure key={shot.id} className="overflow-hidden rounded-inset border border-hairline"><img src={`/api/projects/${encodeURIComponent(projectId)}/workshop/preview/screenshots/${encodeURIComponent(shot.id)}`} alt={`${shot.viewport} preview verification for ${shot.route}`} className="aspect-video w-full object-cover object-top" loading="lazy" /><figcaption className="px-2 py-1 font-mono text-tech text-ink-quiet">{shot.viewport} · {shot.route}</figcaption></figure>)}</div>}{evidence.console_errors.map((error) => <p key={error} className="mt-2 text-meta text-thread">Console: {error}</p>)}{evidence.failed_requests.map((failure) => <p key={`${failure.url}-${failure.status}`} className="mt-2 text-meta text-thread">Request: {failure.status ?? 'failed'} · {failure.url}</p>)}{evidence.limitation && <p className="mt-2 text-meta text-ink-quiet">Not checked: {evidence.limitation}</p>}</div>;
}
type GoLiveOperation = {
  status: 'idle' | 'running' | 'building' | 'succeeded' | 'failed';
  message: string | null;
  url: string | null;
};

function LiveApp({ data, onReload }: { data: ThreadData & { project: { id: string; name: string } }; onReload: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [goLiveOperation, setGoLiveOperation] = useState<GoLiveOperation | null>(null);
  const onReloadRef = useRef(onReload);
  const liveRefreshSent = useRef(false);
  // Opened by the failure that needs it, and stays open afterwards so a second
  // variable can go in without hunting for the link again.
  const [envOpen, setEnvOpen] = useState(false);
  const sameOriginLiveUrl = (() => {
    if (!data.live_url || typeof window === 'undefined') return null;
    try {
      const url = new URL(data.live_url);
      return url.origin === window.location.origin ? url.toString() : null;
    } catch {
      return null;
    }
  })();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setPreview(await api.post<Preview>(`/api/projects/${data.project.id}/workshop/preview`, {}));
    } catch (e) {
      setPreview({ state: 'error', url: null, message: e instanceof Error ? e.message : 'preview failed' });
    } finally {
      setBusy(false);
    }
  }, [data.project.id]);

  const readPreview = useCallback(async () => {
    const next = await api.get<Preview>(`/api/projects/${data.project.id}/workshop/preview`);
    setPreview(next.state === 'none' ? null : next);
  }, [data.project.id]);

  const readGoLive = useCallback(async () => {
    const next = await api.get<GoLiveOperation>(`/api/projects/${data.project.id}/workshop/golive`);
    setGoLiveOperation(next);
    setNote(next.message);
    if (next.url && !liveRefreshSent.current) {
      liveRefreshSent.current = true;
      onReloadRef.current();
    }
  }, [data.project.id]);

  useEffect(() => { onReloadRef.current = onReload; }, [onReload]);
  useEffect(() => { liveRefreshSent.current = false; }, [data.project.id]);
  useEffect(() => { void readPreview().catch(() => undefined); }, [readPreview]);
  useEffect(() => { void readGoLive().catch(() => undefined); }, [readGoLive]);
  useEffect(() => {
    if (goLiveOperation?.status !== 'running') return;
    const timer = window.setInterval(() => void readGoLive().catch(() => undefined), 2000);
    return () => window.clearInterval(timer);
  }, [goLiveOperation?.status, readGoLive]);
  useEffect(() => {
    if (preview?.state !== 'starting') return;
    const timer = window.setInterval(() => void readPreview().catch(() => undefined), 2000);
    return () => window.clearInterval(timer);
  }, [preview?.state, readPreview]);

  // Opening the workspace should show the work, not another button. Only
  // staged work auto-starts a preview; browsing old context remains passive.
  useEffect(() => {
    if (preview !== null || busy) return;
    // A same-origin live app is safe to embed as the stable baseline when no
    // staged workspace copy exists. External deployments may block framing,
    // so those remain one-click links instead of rendering as a blank iframe.
    if (!data.staged_changes_ready && sameOriginLiveUrl) {
      setPreview({ state: 'ready', url: sameOriginLiveUrl, message: null });
      return;
    }
    if (data.staged_changes_ready) void load();
  }, [data.staged_changes_ready, preview, busy, load, sameOriginLiveUrl]);

  // When a turn finishes, what you are looking at is out of date — refresh it
  // so the preview shows what the agent just did.
  useEffect(() => {
    if (!data.working && preview?.state === 'ready') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.working]);

  async function goLive() {
    if (!window.confirm('Deploy this app to your connected hosting account? This creates or updates a public production service. Your private Selvedge preview will remain separate.')) return;
    setBusy(true);
    setNote(null);
    try {
      const next = await api.post<GoLiveOperation>(`/api/projects/${data.project.id}/workshop/golive`, {});
      setGoLiveOperation(next);
      setNote(next.message);
      onReload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-work">
      <div className="rounded-card border border-action/30 bg-sage p-work">
        <p className="section-label">Your workspace</p>
        <p className="text-body leading-relaxed text-ink-dim">Selvedge opens the result here when an agent has something ready for you to see.</p>
      </div>
      {data.live_url ? (
        <div className="flex flex-wrap items-center justify-between gap-work-tight">
          <p className="text-body text-ink">
            Online at{' '}
            <a href={data.live_url} target="_blank" rel="noopener noreferrer" className="text-action-bright hover:underline">
              {data.live_url.replace(/^https:\/\//, '')}
            </a>
          </p>
          <a href={data.live_url} target="_blank" rel="noopener noreferrer" className={btnPrimary}>
            Open live app ↗
          </a>
        </div>
      ) : (
        <div className="space-y-work-tight">
          <p className="text-body text-ink-dim">The preview below is private. Deploy only when you want a separate public production app.</p>
          <button disabled={busy || goLiveOperation?.status === 'running' || goLiveOperation?.status === 'building'} onClick={() => void goLive()} className={btnPrimary}>
            {busy || goLiveOperation?.status === 'running' ? 'Creating production app…' : goLiveOperation?.status === 'building' ? 'Production host is building…' : 'Deploy to production hosting'}
          </button>
          {note && <p className="text-meta text-ink-quiet">{note}</p>}
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-hairline bg-panel">
        <div className="flex items-center justify-between border-b border-hairline px-work py-work-tight">
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Preview</p>
          {preview?.state === 'ready' && (
            <button onClick={() => void load()} disabled={busy} className="text-meta font-medium text-action-bright hover:underline disabled:opacity-50">
              {busy ? 'Refreshing…' : 'Refresh preview'}
            </button>
          )}
        </div>
        {preview?.state === 'ready' && preview.url ? (
          <><WorkspacePreview
            url={preview.url}
            title={data.staged_changes_ready ? 'Latest agent work · live preview' : 'Current app · live preview'}
            safetyLine={data.staged_changes_ready ? 'development copy · nothing ships without your approval' : 'current project baseline'}
            onReload={() => void load()}
            reloading={busy}
          />{preview.evidence && <PreviewEvidencePanel projectId={data.project.id} evidence={preview.evidence} />}</>
        ) : (
          <div className="p-work">
            {!busy && (preview === null || preview.state === 'error') && (
              <button
                type="button"
                onClick={() => void load()}
                className="w-full rounded-inset bg-action px-4 py-3 text-body font-semibold text-ink shadow-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
              >
                {preview?.state === 'error' ? 'Try app preview again →' : 'Open app preview →'}
              </button>
            )}
            <p className="mt-3 text-body text-ink-quiet">
            {busy || preview?.state === 'starting'
              ? 'Waking the workshop and starting the app — this can take a minute the first time.'
              : preview?.state === 'error' && data.live_url
                ? `The workshop copy could not start: ${preview.message ?? 'preview unavailable'} The live app above is still available.`
                : preview?.message ?? 'Open the preview to see the workshop build running here.'}
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
          </div>
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
  onChangeAgent,
  tab,
  onTabChange,
}: {
  data: ThreadData;
  onReload: () => void;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onChangeAgent: () => void;
  tab: ContextTab;
  onTabChange: (tab: ContextTab) => void;
}) {
  // A subject's thread has no project behind it, so it has no work cards, no
  // app to preview and no pack — the panel simply isn't shown for one.
  const project = data.project;
  const tabs: Array<{ id: ContextTab; label: string }> = [
    { id: 'memory', label: 'Context' },
    { id: 'preview', label: 'Preview' },
    { id: 'timeline', label: 'History' },
    { id: 'pack', label: 'About' },
  ];
  if (!project) return null;

  return (
    <aside aria-label="Context" className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-work py-work-tight">
        <div className="flex min-w-0 gap-0.5 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              aria-current={tab === t.id ? 'true' : undefined}
              className={`shrink-0 rounded-inset px-2.5 py-work-tight text-meta focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
                tab === t.id ? 'bg-panel-soft text-ink' : 'text-ink-quiet hover:text-ink-dim'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} title="Hide this panel (Esc)" className="shrink-0 text-meta text-ink-quiet hover:text-ink-dim">
          Hide
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-work">
        {tab === 'memory' && <MemoryNow data={{ ...data, project }} onChangeAgent={onChangeAgent} />}
        {tab === 'preview' && (
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
