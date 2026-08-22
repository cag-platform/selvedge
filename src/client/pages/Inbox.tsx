import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Rail } from '../components/Rail.js';
import { ThreadPane } from '../components/ThreadPane.js';
import { ContextPanel } from '../components/ContextPanel.js';
import { Palette } from '../components/Palette.js';
import { TimelineTab } from '../components/TimelineTab.js';
import { allThreads, type InboxData, type ThreadData } from '../lib/inbox.js';

/**
 * THE INBOX — the place to work.
 *
 * One persistent three-pane layout instead of four pages: the rail (projects,
 * their threads, the brief pinned at the top), the thread (the conversation and
 * everything you do to it), and the context panel (work cards, the app running,
 * what Selvedge understands). Today stays the front door; this is where you go
 * after reading it.
 *
 * Two rules from the design notes are enforced here rather than in the pieces:
 * the panes are SOLID panels on flat paper (the glass budget is spent on the
 * nav and the brief, and a third blurred layer would break it), and there is
 * one motion token — panes arrive with --settle and then hold still.
 *
 * Liveness is polling, as everywhere else in this product: 3 seconds while an
 * agent is working, 12 when it isn't. No SSE, no websockets — that remains a
 * deliberate simplification, and the thread's own text is what moves.
 */

const NARROW = 1280;
const PHONE = 768;

export function Inbox() {
  const { threadId, projectId } = useParams();
  const navigate = useNavigate();
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [contextOpen, setContextOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= NARROW));
  const [newThread, setNewThread] = useState<{ projectId: string; kind: 'workshop' | 'general' } | null>(null);
  // On a phone the three panes become a drill: rail → thread → context.
  const [view, setView] = useState<'rail' | 'thread' | 'context'>('thread');
  const composerRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Poll: fast while something is actually happening, gently otherwise.
  useEffect(() => {
    const interval = setInterval(() => {
      void loadThread();
      void loadInbox();
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

  /** Make somewhere to put work that isn't a codebase. */
  const createSubject = useCallback(async () => {
    const name = window.prompt('What is this subject? (a name is enough)');
    if (!name?.trim()) return;
    try {
      await api.post('/api/subjects', { name: name.trim() });
      await loadInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't go through");
    }
  }, [loadInbox]);

  const createThread = useCallback(
    async (projectId: string, kind: 'workshop' | 'general') => {
      try {
        const res = await api.post<{ thread: { id: string } }>(`/api/projects/${projectId}/threads`, { kind });
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
        if (target) setNewThread({ projectId: target, kind: 'workshop' });
        return;
      }
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (newThread) setNewThread(null);
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
  }, [inbox, newThread, open, paletteOpen, projectId, switcherOpen, thread, threadId, threads]);

  if (error && !inbox) return <p className="p-work text-body text-thread">{error}</p>;

  const phone = width < PHONE;
  const showRail = !phone || view === 'rail';
  const showThread = !phone || view === 'thread';
  const showContext = (!phone && contextOpen) || (phone && view === 'context');

  return (
    <div className="animate-settle flex h-[calc(100vh-var(--nav-height))] overflow-hidden">
      {showRail && (
        <div className={`${phone ? 'w-full' : 'w-rail shrink-0'} border-r border-hairline bg-panel`}>
          <Rail
            data={inbox}
            activeThreadId={threadId ?? null}
            activeProjectId={projectId ?? null}
            onOpen={(t) => open(t.id)}
            onOpenProject={openProject}
            onNewThread={(id) => setNewThread({ projectId: id, kind: 'workshop' })}
            onNewSubjectThread={(id) => void createSubjectThread(id)}
            onNewSubject={() => void createSubject()}
          />
        </div>
      )}

      {showThread && (
        <main className="flex min-w-0 flex-1 flex-col bg-paper">
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

          {newThread && (
            <NewThreadBar
              kind={newThread.kind}
              onToggle={() => setNewThread({ ...newThread, kind: newThread.kind === 'workshop' ? 'general' : 'workshop' })}
              onCreate={() => {
                const target = newThread;
                setNewThread(null);
                void createThread(target.projectId, target.kind);
              }}
              onCancel={() => setNewThread(null)}
            />
          )}

          {projectId ? (
            <ProjectHistory
              projectId={projectId}
              name={inbox?.projects.find((p) => p.id === projectId)?.name ?? projectId}
              onOpenThread={open}
              onNewThread={() => setNewThread({ projectId, kind: 'workshop' })}
            />
          ) : thread ? (
            <ThreadPane
              data={thread}
              onReload={() => {
                void loadThread();
                void loadInbox();
              }}
              onOpenThread={open}
              switcherOpen={switcherOpen}
              onSwitcherOpenChange={setSwitcherOpen}
              composerRef={composerRef}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="max-w-sm text-center text-body text-ink-quiet">
                Nothing open. Pick a conversation on the left, or press + on a project to start one.
              </p>
            </div>
          )}
        </main>
      )}

      {showContext && thread && !projectId && (
        <div className={`${phone ? 'w-full' : 'w-context shrink-0'} border-l border-hairline bg-panel`}>
          <ContextPanel
            data={thread}
            onReload={() => void loadThread()}
            onClose={() => (phone ? setView('thread') : setContextOpen(false))}
            onOpenThread={open}
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

      <Palette data={inbox} open={paletteOpen} onClose={() => setPaletteOpen(false)} onOpenThread={open} />
    </div>
  );
}

/** Pick what kind of conversation this is: Tab toggles, Enter starts it, Esc drops it. */
function NewThreadBar({
  kind,
  onToggle,
  onCreate,
  onCancel,
}: {
  kind: 'workshop' | 'general';
  onToggle: () => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          onToggle();
        }
        if (e.key === 'Enter') onCreate();
        if (e.key === 'Escape') onCancel();
      }}
      className="flex flex-wrap items-center gap-work border-b border-hairline bg-panel-soft px-work-loose py-work focus-visible:outline-none"
    >
      <p className="text-body text-ink">Start with —</p>
      <div className="flex gap-work-tight">
        {(['workshop', 'general'] as const).map((option) => (
          <button
            key={option}
            onClick={() => (option === kind ? onCreate() : onToggle())}
            aria-pressed={option === kind}
            className={`rounded-inset px-work py-work-tight text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
              option === kind ? 'bg-action text-ink' : 'text-ink-dim hover:text-ink'
            }`}
          >
            {/* Who answers first, not what kind of room this is. The two used
                to be the same thing and that was the wall: a conversation
                could never move between them. */}
            {option === 'workshop' ? 'Claude Code — builds' : 'Claude — talks it through'}
          </button>
        ))}
      </div>
      <p className="text-meta text-ink-quiet">You can hand it to anyone later, mid-conversation, by naming them.</p>
      <p className="font-mono text-tech text-ink-quiet">Tab switches · Enter starts it · Esc drops it</p>
      <button onClick={onCancel} className="ml-auto text-meta text-ink-quiet hover:text-ink-dim">
        Cancel
      </button>
    </div>
  );
}

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
