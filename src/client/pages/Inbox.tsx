import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Rail } from '../components/Rail.js';
import { RailSkeleton, ThreadSkeleton, useLoadingPhase, SLOW_LINE } from '../components/ui.js';
import { ThreadPane } from '../components/ThreadPane.js';
import { ContextPanel, type ContextTab } from '../components/ContextPanel.js';
import { Palette } from '../components/Palette.js';
import { TimelineTab } from '../components/TimelineTab.js';
import { allThreads, type InboxData, type ThreadData } from '../lib/inbox.js';

/**
 * THE INBOX — the place to work.
 *
 * One persistent three-pane layout instead of four pages: the rail (everywhere
 * you work and every conversation under it), the thread (the conversation and
 * everything you do to it), and the context panel (what is true now, what has
 * happened, and what Selvedge understands this to be). This is the front door
 * — there is no page to read before you can get to the work.
 *
 * Two rules from the design notes are enforced here rather than in the pieces:
 * the panes are SOLID panels on flat paper (the glass budget is spent on the
 * nav, and a third blurred layer would break it), and there is one motion
 * token — panes arrive with --settle and then hold still.
 *
 * Liveness is polling, as everywhere else in this product: 3 seconds while an
 * agent is working, 12 when it isn't. No SSE, no websockets — that remains a
 * deliberate simplification, and the thread's own text is what moves.
 */

const NARROW = 1280;
const PHONE = 768;
const RAIL_MIN = 220;
const RAIL_MAX = 440;
const CONTEXT_MIN = 280;
const CONTEXT_MAX = 620;

export type LiveReply = {
  turnId: string;
  agent: string;
  consultationId?: string;
  capability: 'chat' | 'build' | 'visual';
  text: string;
  status: 'streaming' | 'finished' | 'cancelled';
};

function savedWidth(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ResizeHandle({ label, value, min, max, direction, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={`${label}. Drag, or use the arrow keys.`}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = (event.key === 'ArrowRight' ? 16 : -16) * direction;
        onChange(clamp(value + delta));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startValue = value;
        const move = (next: PointerEvent) => onChange(clamp(startValue + (next.clientX - startX) * direction));
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
      }}
      className="group relative w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-hairline transition-colors group-hover:bg-action group-focus-visible:bg-action" />
    </div>
  );
}

export function Inbox() {
  const { threadId, projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [liveReplies, setLiveReplies] = useState<Record<string, LiveReply>>({});
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [contextOpen, setContextOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= NARROW));
  const [contextTab, setContextTab] = useState<ContextTab>('memory');
  const [railWidth, setRailWidth] = useState(() => savedWidth('selvedge.rail-width', 272));
  const [contextWidth, setContextWidth] = useState(() => savedWidth('selvedge.context-width', 336));
  // On a phone the three panes become a drill: rail → thread → context.
  const [view, setView] = useState<'rail' | 'thread' | 'context'>('thread');
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (searchParams.get('search') !== '1') return;
    setPaletteOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('search');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => { window.localStorage.setItem('selvedge.rail-width', String(railWidth)); }, [railWidth]);
  useEffect(() => { window.localStorage.setItem('selvedge.context-width', String(contextWidth)); }, [contextWidth]);

  const loadInbox = useCallback(
    () => api.get<InboxData>('/api/inbox').then(setInbox).catch((e: Error) => setError(e.message)),
    [],
  );

  const loadThread = useCallback(() => {
    if (!threadId) {
      setThread(null);
      return Promise.resolve();
    }
    return api
      .get<ThreadData>(`/api/threads/${threadId}`)
      .then(setThread)
      .catch((e: Error) => setError(e.message));
  }, [threadId]);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  // Same-origin SSE needs no second auth mechanism: Clerk's session cookie
  // rides with EventSource. Each event is only a wake-up; the ordinary thread
  // endpoint remains the single canonical wire shape and polling remains the
  // reconnect fallback.
  useEffect(() => {
    if (!threadId || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type?: string; text?: string; turnId?: string; agent?: string; consultationId?: string; capability?: LiveReply['capability'] };
        const key = event.turnId;
        if (event.type === 'reply_started' && key && event.agent) {
          setLiveReplies((current) => ({ ...current, [key]: { turnId: key, agent: event.agent!, ...(event.consultationId ? { consultationId: event.consultationId } : {}), capability: event.capability ?? 'chat', text: '', status: 'streaming' } }));
        }
        else if (event.type === 'reply_delta' && key && event.text) setLiveReplies((current) => current[key] ? ({ ...current, [key]: { ...current[key]!, text: current[key]!.text + event.text! } }) : current);
        else if (event.type === 'reply_finished' || event.type === 'reply_cancelled') {
          if (key) setLiveReplies((current) => current[key] ? ({ ...current, [key]: { ...current[key]!, status: event.type === 'reply_finished' ? 'finished' : 'cancelled' } }) : current);
          void loadThread();
        } else void loadThread();
      } catch {
        void loadThread();
      }
    };
    return () => events.close();
  }, [threadId, loadThread]);

  useEffect(() => setLiveReplies({}), [threadId]);

  useEffect(() => {
    if (!thread) return;
    setLiveReplies((current) => Object.fromEntries(Object.entries(current).filter(([, reply]) => {
      if (reply.status === 'streaming') return true;
      return !thread.messages.some((message) => message.role === 'agent' && message.answered_by === reply.agent && (!reply.consultationId || message.consultation_id === reply.consultationId));
    })));
  }, [thread]);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Poll: fast while something is actually happening, gently otherwise.
  useEffect(() => {
    const interval = setInterval(() => {
      void loadThread();
      // The active conversation is the latency-sensitive surface. The rail
      // does not need a second request every three seconds while that turn is
      // working; it reconciles when the turn settles or on its quiet cadence.
      if (!thread?.working) void loadInbox();
    }, thread?.working ? 3000 : 12000);
    return () => clearInterval(interval);
  }, [thread?.working, loadThread, loadInbox]);

  const threads = useMemo(() => allThreads(inbox), [inbox]);

  // Landing on /inbox with nothing chosen opens the most recent conversation —
  // the one you were last in, in practice.
  useEffect(() => {
    if (threadId || projectId || threads.length === 0) return;
    const newest = [...threads].sort((a, b) => b.last_at.localeCompare(a.last_at))[0];
    if (newest) navigate(`/inbox/${newest.id}`, { replace: true });
  }, [threadId, projectId, threads, navigate]);

  const open = useCallback(
    (id: string) => {
      navigate(`/inbox/${id}`);
      setView('thread');
    },
    [navigate],
  );

  /** A project's own history, in the middle pane — the question the rail's
   *  project row asks, which no single conversation can answer. */
  const openProject = useCallback(
    (id: string) => {
      navigate(`/inbox/project/${id}`);
      setView('thread');
    },
    [navigate],
  );

  /** A conversation under a subject: no project, no sandbox, nothing to ship. */
  const createSubjectThread = useCallback(
    async (subjectId: string) => {
      try {
        const res = await api.post<{ thread: { id: string } }>(`/api/subjects/${subjectId}/threads`, {});
        await loadInbox();
        navigate(`/inbox/${res.thread.id}`);
        setView('thread');
        setTimeout(() => composerRef.current?.focus(), 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "that didn't go through");
      }
    },
    [loadInbox, navigate],
  );

  /**
   * START AN IDEA — a plain conversation about nothing in particular, yet.
   *
   * No project, no sandbox, nothing to ship, and no ceremony asking what it is
   * about: the point of an idea is that you do not know yet. It lands under an
   * "Ideas" subject the server makes on first use, so it is in the rail and
   * searchable from the moment it exists.
   */
  const startIdea = useCallback(async () => {
    try {
      const res = await api.post<{ thread: { id: string } }>('/api/ideas', {});
      await loadInbox();
      navigate(`/inbox/${res.thread.id}`);
      setView('thread');
      setTimeout(() => composerRef.current?.focus(), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't go through");
    }
  }, [loadInbox, navigate]);

  /** Make somewhere to put work that isn't a codebase. */
  const createSubject = useCallback(async () => {
    const name = window.prompt('What are we building today?');
    if (!name?.trim()) return;
    try {
      await api.post('/api/subjects', { name: name.trim() });
      await loadInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't go through");
    }
  }, [loadInbox]);

  /**
   * Fold a place out of the rail, or bring it back. One endpoint whichever
   * kind of place it is — the rail is one list, and it should not have to know
   * which rows have a repo behind them to act on them.
   */
  const putAway = useCallback(
    async (place: { id: string; name: string }, away: boolean) => {
      try {
        await api.patch(`/api/inbox/places/${place.id}`, { put_away: away });
        await loadInbox();
      } catch (e) {
        setError(e instanceof Error ? e.message : "that didn't go through");
      }
    },
    [loadInbox],
  );

  /**
   * Pressing + starts the conversation. It does not ask a question first.
   *
   * There used to be a bar here that made you pick "Claude Code — builds" or
   * "Claude — talks it through" before you could type a word. That was the one
   * decision this redesign exists to make free: you name whoever you want in
   * the sentence, mid-conversation, and hand it over as often as you like. A
   * gate in front of the composer asked you to commit to an answer before you
   * had finished having the thought — and it put one vendor's name on the
   * door of an app that talks to four.
   */
  const createThread = useCallback(
    async (projectId: string) => {
      setError(null);
      try {
        // Encoded: a project id is not guaranteed to be URL-safe, and an
        // unencoded one fails as a 404 that looks like "nothing happened".
        const res = await api.post<{ thread: { id: string } }>(`/api/projects/${encodeURIComponent(projectId)}/threads`, {});
        await loadInbox();
        open(res.thread.id);
        // Straight into typing — a new thread is one tap and a sentence.
        setTimeout(() => composerRef.current?.focus(), 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "that didn't go through");
      }
    },
    [loadInbox, open],
  );

  // The keyboard. Every one of these is also reachable by pointer, and the
  // palette lists them — a shortcut that is the only path to something is an
  // accessibility failure, not a power feature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
        return;
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const target = projectId ?? thread?.project?.id ?? inbox?.projects[0]?.id;
        if (target) void createThread(target);
        return;
      }
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (switcherOpen) setSwitcherOpen(false);
        else setContextOpen(false);
        return;
      }
      // j / k move through the rail, but only when you are not typing.
      const typing = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement | null)?.tagName ?? '');
      if (typing || meta || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') {
        const index = threads.findIndex((t) => t.id === threadId);
        const next = e.key === 'j' ? index + 1 : index - 1;
        const target = threads[next];
        if (target) {
          e.preventDefault();
          open(target.id);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [createThread, inbox, open, paletteOpen, projectId, switcherOpen, thread, threadId, threads]);

  // A first-load failure is the whole screen; anything after it is a banner
  // over the working one. What must never happen — and did — is an error with
  // nowhere to appear: `setError` on a failed action wrote to state that only
  // rendered while `inbox` was null, so once the rail had loaded, a refused
  // action produced SILENCE. A button that does nothing and says nothing is
  // the interface version of the one output this product can't have.
  if (error && !inbox) return <p className="p-work text-body text-thread">{error}</p>;

  // WHAT EACH PANE SHOWS WHILE IT FILLS. Under 150ms, nothing at all — a
  // skeleton that appears and vanishes that fast is its own flash of jank, and
  // most responses land inside it. Past eight seconds the shape stops being
  // honest and the pane says the true thing instead, without giving up.
  const railPhase = useLoadingPhase(inbox === null);
  const threadPhase = useLoadingPhase(threadId !== null && thread === null);

  const phone = width < PHONE;
  const showRail = !phone || view === 'rail';
  const showThread = !phone || view === 'thread';
  const showContext = (!phone && contextOpen) || (phone && view === 'context');

  return (
    <div className="animate-settle flex h-[calc(100vh-var(--nav-height))] flex-col overflow-hidden">
      {error && (
        <div className="flex items-center gap-work border-b-2 border-thread bg-panel-soft px-work-loose py-work-tight">
          <p className="flex-1 text-body font-medium text-thread">{error}</p>
          <button onClick={() => setError(null)} className="text-meta text-ink-quiet hover:text-ink-dim">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {showRail && (
        <div className={`${phone ? 'w-full' : 'shrink-0'} workbench-rail bg-panel`} style={phone ? undefined : { width: railWidth }}>
          {inbox === null ? (
            <>
              {railPhase !== 'idle' && <RailSkeleton />}
              {railPhase === 'slow' && <p className="px-work text-meta text-ink-quiet">{SLOW_LINE}</p>}
            </>
          ) : (
          <Rail
            data={inbox}
            activeThreadId={threadId ?? null}
            activeProjectId={projectId ?? null}
            onOpen={(t) => open(t.id)}
            onOpenProject={openProject}
            onNewThread={(id) => void createThread(id)}
            onNewSubjectThread={(id) => void createSubjectThread(id)}
            onNewSubject={() => void createSubject()}
            onStartIdea={() => void startIdea()}
            onPutAway={(place, away) => void putAway(place, away)}
          />
          )}
        </div>
      )}

      {!phone && showRail && showThread && (
        <ResizeHandle label="Resize threads panel" value={railWidth} min={RAIL_MIN} max={RAIL_MAX} direction={1} onChange={setRailWidth} />
      )}

      {showThread && (
        <main className="workbench-thread flex min-w-0 flex-1 flex-col bg-paper">
          {phone && (
            <div className="flex items-center justify-between border-b border-hairline px-work py-work-tight text-meta text-ink-quiet">
              <button onClick={() => setView('rail')} className="hover:text-ink-dim">
                ← All threads
              </button>
              {thread && (
                <button onClick={() => setView('context')} className="hover:text-ink-dim">
                  Context →
                </button>
              )}
            </div>
          )}

          {projectId ? (
            <ProjectHistory
              projectId={projectId}
              name={inbox?.projects.find((p) => p.id === projectId)?.name ?? projectId}
              onOpenThread={open}
              onNewThread={() => void createThread(projectId)}
            />
          ) : thread ? (
            <ThreadPane
              data={thread}
              liveReplies={Object.values(liveReplies)}
              onReload={() => {
                void loadThread();
                void loadInbox();
              }}
              onOpenThread={open}
              switcherOpen={switcherOpen}
              onSwitcherOpenChange={setSwitcherOpen}
              composerRef={composerRef}
              onShowPreview={() => {
                setContextTab('preview');
                setContextOpen(true);
                if (phone) setView('context');
              }}
            />
          ) : threadId ? (
            // A thread was asked for and hasn't arrived. The shape goes here,
            // inside the frame, so nothing moves when the words land.
            <>
              {threadPhase !== 'idle' && <ThreadSkeleton />}
              {threadPhase === 'slow' && <p className="px-work-loose text-meta text-ink-quiet">{SLOW_LINE}</p>}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="max-w-sm text-center text-body text-ink-quiet">
                Nothing open. Pick a conversation on the left, or press + on a project to start one.
              </p>
            </div>
          )}
        </main>
      )}

      {!phone && showContext && showThread && thread && !projectId && (
        <ResizeHandle label="Resize context panel" value={contextWidth} min={CONTEXT_MIN} max={CONTEXT_MAX} direction={-1} onChange={setContextWidth} />
      )}

      {showContext && thread && !projectId && (
        <div className={`${phone ? 'w-full' : 'shrink-0'} workbench-context bg-panel`} style={phone ? undefined : { width: contextWidth }}>
          <ContextPanel
            data={thread}
            onReload={() => void loadThread()}
            onClose={() => (phone ? setView('thread') : setContextOpen(false))}
            onOpenThread={open}
            onChangeAgent={() => {
              setSwitcherOpen(true);
              if (phone) setView('thread');
            }}
            tab={contextTab}
            onTabChange={setContextTab}
          />
        </div>
      )}

      {!phone && !contextOpen && thread && !projectId && (
        <button
          onClick={() => setContextOpen(true)}
          className="border-l border-hairline px-work-tight text-meta text-ink-quiet hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          title="Show context"
        >
          <span className="[writing-mode:vertical-rl]">Context</span>
        </button>
      )}
      </div>

      <Palette data={inbox} open={paletteOpen} onClose={() => setPaletteOpen(false)} onOpenThread={open} />
    </div>
  );
}

/** Pick what kind of conversation this is: Tab toggles, Enter starts it, Esc drops it. */
/**
 * One project's history, given the room to be read. The context panel's
 * History tab answers "what happened here?" beside a conversation; this is the
 * same list with the reading register's air around it, for when that question
 * IS the task — including for a project with no conversations at all, whose
 * history would otherwise have nowhere to appear.
 */
function ProjectHistory({
  projectId,
  name,
  onOpenThread,
  onNewThread,
}: {
  projectId: string;
  name: string;
  onOpenThread: (threadId: string) => void;
  onNewThread: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-read py-read">
      <header className="mb-read flex flex-wrap items-baseline justify-between gap-work">
        <div>
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">What happened</p>
          {/* Inter, not Fraunces: the note's voice belongs to the brief, and
              the workbench keeps it that way even on a reading surface. */}
          <h1 className="text-headline font-medium text-ink">{name}</h1>
        </div>
        <button onClick={onNewThread} className="text-meta text-action-bright hover:underline">
          Start something here
        </button>
      </header>
      <TimelineTab projectId={projectId} onOpenThread={onOpenThread} />
    </div>
  );
}
