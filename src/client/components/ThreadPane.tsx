import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatCents } from '../lib/ledger.js';
import { describeToolEvent, summarizeRecord, type RunRecordView } from '../lib/replay.js';
import { Reveal } from './Reveal.js';
import { AgentChip } from './AgentChip.js';
import { AgentMenu } from './AgentMenu.js';
import { ReferenceMenu } from './ReferenceMenu.js';
import { completeMention, mentionQuery, sendNote, type AgentOffer, type RosterResponse } from '../lib/agents.js';
import { PendingChips, AttachButtons, pastedImageFiles, addImages, addDocs, type PendingImage, type PendingFile } from './WorkshopAttach.js';
import { DecisionCard } from './DecisionCard.js';
import { staleRefusalOf, type StaleRefusal } from '../lib/decision.js';
import { ceilingRefusalOf, money, raiseLabel, type CeilingRefusal } from '../lib/ceiling.js';
import { needsProjectOf, repoSlug, type NeedsProject } from '../lib/needsProject.js';
import { referenceNote, type ReferenceCandidate, type ReferencesResponse } from '../lib/references.js';
import { completeReference, referenceQuery } from '../../shared/references.js';
import {
  isDocumentSized,
  nameForPaste,
  sayLength,
  MAX_DOCUMENTS,
  TOO_MANY_DOCUMENTS,
  NEEDS_A_QUESTION,
  type PastedDocument,
} from '../../shared/documents.js';
import { agentById } from '../../shared/agents.js';
import { WorkCard } from './WorkCard.js';
import { EmptyState } from './ui.js';
import { needsOwner, type WorkCardData } from '../lib/card.js';
import type { ThreadData, ThreadMessage } from '../lib/inbox.js';

type ContextReceipt = { sections: { about: string[]; recent: string[]; open: string[] } };

function ReceivedContext({ projectId }: { projectId: string }) {
  const [received, setReceived] = useState<ContextReceipt | null>(null);
  useEffect(() => {
    api.get<ContextReceipt>(`/api/projects/${encodeURIComponent(projectId)}/context`).then(setReceived).catch(() => setReceived(null));
  }, [projectId]);
  if (!received) return null;
  const count = received.sections.about.length + received.sections.recent.length + received.sections.open.length;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-dim" aria-label="Context received by the current builder">
      <span className="font-medium text-action-bright">Context received</span>
      <span aria-hidden>·</span><span>{count} grounded lines</span>
      <span aria-hidden>·</span><span>{received.sections.recent.length} recent records</span>
      <span aria-hidden>·</span><span>{received.sections.open.length} open questions</span>
    </p>
  );
}

/**
 * One attached document on the thread: its name and size, and the whole of it
 * one click away. Fetched on opening rather than with the thread, because a
 * conversation is polled every few seconds and a document is large.
 */
function AttachedDocument({
  threadId,
  messageId,
  doc,
}: {
  threadId: string;
  messageId: string;
  doc: { index: number; name: string; chars: number };
}) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function show() {
    setOpen(true);
    if (text !== null || busy) return;
    setBusy(true);
    try {
      const got = await api.get<{ text: string }>(`/api/threads/${threadId}/documents/${messageId}/${doc.index}`);
      setText(got.text);
    } catch {
      setText("I couldn't read that back just now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-work-tight rounded-inset border border-hairline bg-panel-soft px-3 py-2">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : void show())}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-meta text-ink">{doc.name}</span>
        <span className="shrink-0 font-mono text-tech text-ink-quiet">{sayLength(doc.chars)}</span>
        <span className="shrink-0 text-meta text-ink-quiet">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-tech text-ink-dim">
          {busy && text === null ? 'Reading it back…' : text}
        </pre>
      )}
    </div>
  );
}

/** The name over a message: "Selvedge" unless somebody specific was asked. */
function speakerOf(message: ThreadMessage): string {
  if (message.role === 'owner') return 'You';
  if (!message.answered_by) return 'Selvedge';
  return agentById(message.answered_by)?.name ?? 'Selvedge';
}

/**
 * THE THREAD — the conversation, and everything you do to it, in one column.
 *
 * The Workshop used to be a page of its own with the work bolted around the
 * outside: ship controls above the chat, the preview beside it, the go-live
 * button in a bar. In the workbench the conversation IS the place, so shipping
 * and the agent's activity live inline where the work happened, and the panel
 * on the right holds context rather than actions.
 *
 * Liveness is textual and nothing else: while an agent runs, the activity line
 * updates with what it is actually doing. No spinner, no shimmer, no progress
 * bar that guesses — content moves, chrome does not.
 */

function ShipControls({ data, onDone }: { data: ThreadData & { project: { id: string; name: string } }; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [needsBackup, setNeedsBackup] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lastShip = data.runs.find((r) => r.kind === 'ship' && r.commit)?.commit ?? null;

  async function ship() {
    setBusy(true);
    setNote(null);
    try {
      await api.post(`/api/projects/${data.project.id}/workshop/ship`, { backup_confirmed: backupConfirmed });
      setNeedsBackup(false);
      setBackupConfirmed(false);
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'that did not go through';
      if (/backup/i.test(message)) setNeedsBackup(true);
      setNote(message);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastShip) return;
    setBusy(true);
    setNote(null);
    try {
      await api.post(`/api/projects/${data.project.id}/workshop/rollback`, { commit: lastShip });
      onDone();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'the undo did not go through');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-work-tight border-t border-hairline bg-panel-soft px-work-loose py-work">
      <div className="flex flex-wrap items-center justify-between gap-work">
        <p className="text-body text-ink">There’s finished work here that isn’t live yet.</p>
        <div className="flex items-center gap-work">
          {lastShip && (
            <button disabled={busy} onClick={() => void undo()} className="text-meta text-ink-quiet hover:text-thread disabled:opacity-50">
              Undo last ship
            </button>
          )}
          <button
            disabled={busy || data.working || (needsBackup && !backupConfirmed)}
            onClick={() => void ship()}
            className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
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

function Message({ message, data }: { message: ThreadMessage; data: ThreadData }) {
  if (message.role === 'switch') {
    // The switch line: one quiet mono sentence stating what was handed over and
    // what carrying it cost. This line is the feature made visible.
    return (
      <p className="py-work-tight font-mono text-tech text-ink-quiet">{message.content}</p>
    );
  }

  if (message.role === 'activity') {
    const record = message.meta as RunRecordView | null;
    const run = data.runs.find((r) => r.id === record?.run_id);
    return (
      <div className="border-l-2 border-hairline pl-work">
        <p className="whitespace-pre-line font-mono text-tech text-ink-quiet">{message.content}</p>
        {record?.tools && record.tools.length > 0 && (
          <div className="mt-work-tight">
            <Reveal summary={`the full record · ${summarizeRecord(record)}`}>
              {record.tools.map((t) => (
                <div key={t.id}>{describeToolEvent(t)}</div>
              ))}
              {run && (
                <div className="mt-1 text-ink-quiet">
                  {[
                    run.changed_paths?.length ? `files changed: ${run.changed_paths.join(', ')}` : null,
                    run.cost_cents != null ? `cost ${formatCents(run.cost_cents)}` : null,
                    run.agent ? `by ${run.agent}` : null,
                    run.model ? `model ${run.model}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </Reveal>
          </div>
        )}
      </div>
    );
  }

  return (
    <div id={`message-${message.id}`} className={message.role === 'owner' ? 'pl-6' : 'border-l-2 border-hairline pl-work'}>
      {/* Who actually said it. A consultation puts two answers in a row, and
          two paragraphs both labelled "Selvedge" is exactly the confusion
          asking two agents was meant to resolve. */}
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{speakerOf(message)}</p>
      <p className="whitespace-pre-line text-body text-ink">{message.content}</p>
      {/* WHAT WAS ATTACHED, on the record. A document that only existed in the
          prompt would make the thread a partial account of what was asked. */}
      {(message.documents ?? []).map((doc) => (
        <AttachedDocument key={doc.index} threadId={data.thread.id} messageId={message.id} doc={doc} />
      ))}
      {message.attachments.length > 0 && (
        <div className="mt-work-tight flex flex-wrap gap-work-tight">
          {message.attachments.map((a) => (
            <a key={a.id} href={`/api/projects/${data.project?.id}/workshop/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">
              <img
                src={`/api/projects/${data.project?.id}/workshop/attachments/${a.id}`}
                alt="attached"
                className="h-16 w-16 rounded-inset border border-hairline object-cover"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreadPane({
  data,
  onReload,
  onOpenThread,
  switcherOpen,
  onSwitcherOpenChange,
  composerRef,
}: {
  data: ThreadData;
  onReload: () => void;
  onOpenThread: (threadId: string) => void;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  /**
   * The message you just sent, shown before the server has confirmed it.
   * Cleared the moment the real one arrives on a poll — see the effect below,
   * which matches on content rather than id because the server assigns the id.
   */
  const [optimistic, setOptimistic] = useState<ThreadMessage | null>(null);
  // Between pressing Stop and the server confirming. Suspending a sandbox
  // takes a beat, and a button that looks unpressed for that beat gets
  // pressed again.
  const [stopping, setStopping] = useState(false);
  /** Pastes too long to be sentences, riding beside the message. */
  const [documents, setDocuments] = useState<PastedDocument[]>([]);
  /** Everything this account can be pointed at with `#`. Loaded once. */
  const [referenceItems, setReferenceItems] = useState<ReferenceCandidate[]>([]);
  /**
   * Who could answer, and what handing it to each would cost — quoted by the
   * server before anything is handed over. Re-read when the answering agent
   * changes, because a handover's size depends on who it is coming from.
   */
  const [roster, setRoster] = useState<AgentOffer[]>([]);
  /**
   * The work on this project that is waiting on YOU — folded into the thread
   * rather than parked in a side tab. A proposal you never look at is a
   * proposal nobody approved, and the panel it used to live in was closed by
   * default on a laptop. Work already in motion is not here: it belongs in
   * Now, not in front of your face.
   */
  const [proposals, setProposals] = useState<WorkCardData[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(data.thread.title);
  // The building thread's refusal: set when the server declined a turn because
  // the decision behind this thread has fallen behind the thinking.
  const [staleRefusal, setStaleRefusal] = useState<{ refusal: StaleRefusal; message: string } | null>(null);
  // The other refusal with a way through: this conversation has spent what it
  // was allowed to spend, and is asking before it spends more.
  const [ceiling, setCeiling] = useState<{ refusal: CeilingRefusal; message: string } | null>(null);
  // The third refusal with a way through, and the only one that is a MOVE
  // rather than a permission: this idea has nowhere to build yet.
  const [needsProject, setNeedsProject] = useState<{ refusal: NeedsProject; message: string } | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  // Narrows the join-or-create list — on a real account it is twenty-eight
  // projects long, and scrolling a list is slower than typing three letters.
  const [projectFilter, setProjectFilter] = useState('');
  const [moving, setMoving] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const workshop = data.thread.kind === 'workshop';

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, composerRef]);

  /**
   * TO THE TOP OF WHAT ARRIVED, NOT THE BOTTOM OF THE THREAD.
   *
   * Scrolling to the tail put the END of the newest message at the bottom of
   * the viewport — fine for a sentence, useless for a long answer, whose first
   * line was then several screens up. A consultation, which lands two long
   * answers at once, showed apparently blank space and made you scroll back to
   * find where the reply had started. Reading starts at the beginning.
   */
  useEffect(() => {
    const newest = data.messages.at(-1);
    const node = newest ? document.getElementById(`message-${newest.id}`) : null;
    (node ?? end.current)?.scrollIntoView({ behavior: 'smooth', block: node ? 'start' : 'end' });
  }, [data.messages.length, data.messages]);

  useEffect(() => {
    setTitleDraft(data.thread.title);
  }, [data.thread.title]);

  useEffect(() => {
    let live = true;
    api
      .get<RosterResponse>(`/api/threads/${data.thread.id}/agents`)
      .then((r) => {
        if (live) setRoster(r.agents);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [data.thread.id, data.thread.agent]);

  const projectId = data.project?.id ?? null;
  const loadProposals = useCallback(() => {
    if (!projectId) return;
    api
      .get<{ cards: WorkCardData[] }>(`/api/cards?project=${encodeURIComponent(projectId)}`)
      .then((r) => setProposals(r.cards.filter((c) => needsOwner(c.state))))
      .catch(() => setProposals([]));
  }, [projectId]);

  // Re-read when a turn ends: a turn is exactly what raises a card or trips a
  // checkpoint, so waiting for the next visit would hide it.
  useEffect(() => {
    loadProposals();
  }, [loadProposals, data.working]);

  /**
   * The chip and Cmd+J do the same thing the `@` key does: open the roster by
   * starting a mention. One way of choosing who answers, not two — and it
   * costs nothing until the message is actually sent.
   */
  useEffect(() => {
    if (!switcherOpen) return;
    onSwitcherOpenChange(false);
    setText((current) => (mentionQuery(current) !== null ? current : current === '' || current.endsWith(' ') ? `${current}@` : `${current} @`));
    composerRef.current?.focus();
  }, [switcherOpen, onSwitcherOpenChange, composerRef]);

  useEffect(() => {
    api
      .get<ReferencesResponse>('/api/references')
      .then((r) => setReferenceItems(r.items))
      // A picker that can't load is a picker that doesn't open. Typing `#loom`
      // by hand still works, because the parse that matters is the server's.
      .catch(() => setReferenceItems([]));
  }, []);

  // A turn that has started clears the "getting ready" line — the thread is
  // moving again, and saying it twice would be noise.
  useEffect(() => {
    if (data.working) setWarming(false);
  }, [data.working]);

  /**
   * Stop what's running. The sandbox is suspended, which is what actually
   * halts the meter; files it had already written stay where they are. The
   * server answers the same way whether or not anything was in flight, so
   * pressing this on a turn that just finished is not an error.
   */
  async function stop() {
    if (stopping) return;
    setStopping(true);
    setNote(null);
    try {
      await api.post(`/api/threads/${data.thread.id}/stop`, {});
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setStopping(false);
      onReload();
    }
  }

  /**
   * `acknowledgeStale` is only ever true because a person pressed the second
   * button, having read what they were overriding. It is never carried over
   * from a previous send, and never defaulted on.
   */
  useEffect(() => {
    if (!optimistic) return;
    // The server assigns the id, so the stand-in is matched on what it says.
    // Anything older than a minute goes too: a send that neither succeeded nor
    // reported a refusal must not leave a permanent ghost on the thread.
    const landed = data.messages.some((m) => m.role === 'owner' && m.content === optimistic.content);
    const stale = Date.now() - Date.parse(optimistic.at) > 60_000;
    if (landed || stale) setOptimistic(null);
  }, [data.messages, optimistic]);

  async function send(e: React.FormEvent | null, acknowledgeStale = false, raiseCap = false) {
    e?.preventDefault();
    const body = text.trim();
    // A document is not a sentence: an attachment with no words is a message
    // with no ask in it, which the composer says beside the chip rather than
    // discovering here.
    if (body === '' || uploading) return;
    setSending(true);
    setNote(null);
    // YOUR OWN WORDS APPEAR AT ONCE.
    //
    // The round trip is a few hundred milliseconds and the reload after it is
    // another, so the sentence you just pressed send on used to sit in the
    // composer, then vanish, then reappear above it. Putting it on the thread
    // immediately costs nothing and removes the one wait a person notices
    // most, because they are still looking at the words they wrote.
    //
    // Marked pending, and reconciled by the next poll: this is a picture of
    // what was sent, not a claim that it arrived. If the send is refused it is
    // taken straight back off and the text is returned to the composer, so the
    // thread never keeps a message the server declined.
    const pending: ThreadMessage = {
      id: `pending-${Date.now()}`,
      role: 'owner',
      content: body,
      at: new Date().toISOString(),
      attachments: [],
      ...(documents.length ? { documents: documents.map((d, index) => ({ index, name: d.name, chars: d.text.length })) } : {}),
    };
    setOptimistic(pending);
    try {
      const res = await api.post<{ started: boolean; warming: boolean }>(`/api/threads/${data.thread.id}/message`, {
        text: body,
        ...(images.length ? { images: images.map((i) => ({ mime: i.mime, dataBase64: i.dataBase64 })) } : {}),
        ...(files.length ? { files: files.map((f) => ({ id: f.id })) } : {}),
        ...(documents.length ? { documents } : {}),
        ...(acknowledgeStale ? { acknowledge_stale: true } : {}),
        ...(raiseCap ? { raise_cap: true } : {}),
      });
      setText('');
      setImages([]);
      setFiles([]);
      setDocuments([]);
      setStaleRefusal(null);
      setCeiling(null);
      setNeedsProject(null);
      setWarming(res.warming);
      onReload();
    } catch (err) {
      // Refused: take it back off the thread. A message the server declined
      // must not sit there looking sent.
      setOptimistic(null);
      // Both of these are refusals with a way through, not dead ends: keep what
      // was typed, say what is in the way, and let the owner choose. The
      // message is NOT sent by the act of being told.
      const body409 = err instanceof ApiError && err.status === 409 ? err.body : null;
      const stale = body409 ? staleRefusalOf(body409) : null;
      const hit = body409 ? ceilingRefusalOf(body409) : null;
      const nowhere = body409 ? needsProjectOf(body409) : null;
      const message = err instanceof Error ? err.message : '';
      if (stale) setStaleRefusal({ refusal: stale, message });
      else if (hit) setCeiling({ refusal: hit, message });
      else if (nowhere) setNeedsProject({ refusal: nowhere, message });
      else setNote(message || "that didn't go through");
    } finally {
      setSending(false);
    }
  }

  /**
   * GIVE THIS CONVERSATION SOMEWHERE TO BUILD, and then say the thing again.
   *
   * The move is the point: the thread keeps its id and its whole history, so
   * the argument you just had is inside the project it produced. Nothing is
   * summarised and nothing restarts.
   *
   * The message is re-sent rather than held server-side, because the refusal
   * left it in the composer where it is still editable — being told what was in
   * the way is not the same as having agreed to send.
   */
  async function giveItAProject(destination: { project_id: string } | { create: { name: string } }) {
    setMoving(true);
    setNote(null);
    try {
      await api.post(`/api/threads/${data.thread.id}/build`, destination);
      setNeedsProject(null);
      onReload();
      await send(null);
    } catch (err) {
      // A plan wall or a GitHub failure lands here as a plain sentence. The
      // conversation has not moved and nothing was created.
      setNote(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setMoving(false);
    }
  }

  /**
   * Picking a name finishes the mention. It does NOT switch the thread: the
   * choice belongs in the sentence, where it is visible, reversible with one
   * backspace, and free until the message is sent.
   */
  function pickAgent(agent: string) {
    setText((current) => completeMention(current, agent as Parameters<typeof completeMention>[1]));
    composerRef.current?.focus();
  }

  async function rename() {
    setRenaming(false);
    if (titleDraft.trim() === '' || titleDraft === data.thread.title) return;
    await api.patch(`/api/threads/${data.thread.id}`, { title: titleDraft.trim() }).then(onReload).catch(() => undefined);
  }

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-work border-b border-hairline bg-panel-soft/40 px-work-loose py-work-loose">
        <div className="min-w-0">
          <p className="section-label mb-2">Active outcome</p>
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
                if (e.key === 'Escape') {
                  setTitleDraft(data.thread.title);
                  setRenaming(false);
                }
              }}
              className="w-full rounded-inset border border-hairline bg-panel px-2 py-1 font-display text-3xl text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            />
          ) : (
            <button onClick={() => setRenaming(true)} title="Rename this outcome" className="block max-w-3xl truncate text-left font-display text-[clamp(2rem,4vw,3.25rem)] leading-[1.02] tracking-[-0.03em] text-ink hover:text-ink-dim">
              {data.thread.title}
            </button>
          )}
          <p className="truncate text-meta text-ink-quiet">
            {data.project?.name ?? data.subject?.name ?? 'unfiled'} ·{' '}
            {workshop ? 'builds in the sandbox' : data.project ? 'chat, nothing is built here' : 'a conversation about a subject, not a codebase'}
          </p>
          {data.project && <ReceivedContext projectId={data.project.id} />}
        </div>
        <p className="font-mono text-tech text-ink-quiet">
          {formatCents(data.cost_cents)} in this thread
          {workshop && (data.sandbox === 'attached' ? ' · workshop warm' : ' · workshop cold')}
        </p>
      </header>

      <DecisionCard
        threadId={data.thread.id}
        kind={data.thread.kind}
        hasConversation={data.messages.some((m) => m.role === 'owner' || m.role === 'agent')}
        hasProject={Boolean(data.project)}
        onOpenThread={onOpenThread}
        onReload={onReload}
        reloadKey={data.messages.length}
      />

      {/* THE CONVERSATION SITS ON THE COMPOSER, NOT UNDER THE TITLE.
          A short thread used to pin itself to the top of a tall pane, which put
          six hundred pixels of nothing between the last thing said and the box
          you say the next thing in — a room that reads as abandoned at exactly
          the moment it is newest. `mt-auto` on the inner column is the whole
          fix: spare room goes above the messages when there is any, and nothing
          happens when there isn't. Doing it with `justify-end` on the scroller
          instead is the version that quietly makes the top of a long thread
          unreachable. */}
      <div className="flex flex-1 flex-col overflow-y-auto px-work-loose py-work">
        <div className="mt-auto space-y-work-loose">
        {data.messages.length === 0 && (
          // Names where you are, then teaches the two marks — which is the
          // whole interface, and the one thing a first conversation cannot
          // discover on its own.
          <EmptyState
            action={
              <button
                onClick={() => composerRef.current?.focus()}
                className="text-meta text-action-bright hover:underline"
              >
                Start typing
              </button>
            }
          >
            This conversation belongs to {data.project?.name ?? data.subject?.name ?? 'this project'}. Type{' '}
            <span className="font-mono text-tech">@</span> to pick who answers;{' '}
            <span className="font-mono text-tech">#</span> to bring in what you&rsquo;ve already decided.
          </EmptyState>
        )}
        {data.messages.map((m) => (
          <Message key={m.id} message={m} data={data} />
        ))}
        {optimistic && (
          <div className="opacity-60">
            <Message message={optimistic} data={data} />
          </div>
        )}
        {data.working && (
          <div className="flex items-start gap-work border-l-2 border-brass pl-work">
            <div className="flex-1">
              <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge</p>
              <p className="text-body text-ink-dim">Working on it…</p>
            </div>
            {/* The way out. A turn you can start and not stop is a turn that
                owns you rather than the other way round — and while it runs,
                the project takes no other work. */}
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stop()}
              className="text-meta text-ink-quiet hover:text-thread disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        )}
        {warming && !data.working && (
          <p className="font-mono text-tech text-ink-quiet">
            {data.thread.agent === 'codex' ? 'Codex' : 'The workshop'} is getting ready — your message is queued.
          </p>
        )}
        <div ref={end} />
        </div>
      </div>

      {/* Work waiting on you, in the conversation rather than behind a tab.
          The card is the whole card — estimate, cap, gate, verdict — because
          approving is exactly the moment those figures matter. */}
      {proposals.length > 0 && (
        <div className="space-y-work border-t border-hairline bg-panel-soft px-work-loose py-work">
          {proposals.map((card) => (
            <WorkCard
              key={card.id}
              card={card}
              onChanged={() => {
                loadProposals();
                onReload();
              }}
            />
          ))}
        </div>
      )}

      {workshop && data.project && data.staged_changes_ready && (
        <ShipControls data={{ ...data, project: data.project }} onDone={onReload} />
      )}

      <div className="border-t border-hairline px-work-loose py-work">
        <PendingChips
          images={images}
          onImagesChange={setImages}
          files={files}
          onFilesChange={setFiles}
          documents={documents}
          onDocumentsChange={setDocuments}
        />
        {/* Said in front of the decision, not after the press. The send button
            is disabled with nothing typed, and a greyed button beside a chip
            with no explanation is what makes people think a thing is broken. */}
        {documents.length > 0 && text.trim() === '' && (
          <p className="mb-work-tight text-tech text-ink-quiet">{NEEDS_A_QUESTION}</p>
        )}
        {staleRefusal && (
          <div className="mb-work-tight space-y-work-tight rounded-inset border-2 border-thread bg-panel-soft px-3 py-2">
            <p className="text-body font-medium text-thread">{staleRefusal.message}</p>
            <div className="flex flex-wrap items-center gap-work">
              <button
                onClick={() => onOpenThread(staleRefusal.refusal.thinking_thread_id)}
                className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
              >
                Go and refresh the decision
              </button>
              {/* The override is available, plainly worded, and never the
                  default: it is one press, and the thread records that it
                  happened. */}
              <button
                disabled={sending}
                onClick={() => void send(null, true)}
                className="text-meta text-ink-quiet underline hover:text-ink-dim disabled:opacity-50"
              >
                Build from it as it stands
              </button>
            </div>
          </div>
        )}
        {/* THE MOVE, ON PURPOSE. The join-or-create card used to be reachable
            only by naming a builder and being refused. A conversation that has
            no project offers the door itself. */}
        {!data.project && !needsProject && (
          <button
            onClick={() => {
              void api
                .get<{ has_project: boolean; projects: Array<{ id: string; name: string }>; can_create: boolean }>(
                  `/api/threads/${data.thread.id}/build/options`,
                )
                .then((r) => {
                  if (r.has_project) return onReload();
                  setNeedsProject({
                    refusal: { agent: 'a builder', projects: r.projects, canCreate: r.can_create },
                    message: 'Where should this conversation build?',
                  });
                })
                .catch(() => undefined);
            }}
            className="mb-work-tight text-meta text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            Give this conversation a project
          </button>
        )}
        {/* Nothing spends past what you approved — said here, in the place the
            spending actually happens, with the figure and the way through. */}
        {needsProject && (
          <div className="mb-work-tight space-y-work-tight rounded-inset border border-hairline bg-panel-soft px-3 py-2">
            <p className="text-body text-ink">{needsProject.message}</p>
            {/* What survives the move, said before it happens — because the
                whole reason to have had the idea here is that it does. */}
            <p className="text-meta text-ink-quiet">
              This conversation moves with it: everything said here stays, and the next turn builds.
            </p>

            {needsProject.refusal.projects.length > 8 && (
              <input
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="type to narrow the list"
                className="block w-full rounded-inset border border-hairline bg-panel px-3 py-1.5 text-body text-ink placeholder:text-ink-quiet focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
              />
            )}
            {needsProject.refusal.projects.length > 0 && (
              // Bounded for the same reason as the phone's card: twenty-eight
              // projects unbounded push "start a new one" out of reach.
              <div className="flex max-h-40 flex-wrap gap-work-tight overflow-y-auto">
                {needsProject.refusal.projects
                  .filter((p) => p.name.toLowerCase().includes(projectFilter.trim().toLowerCase()))
                  .map((p) => (
                  <button
                    key={p.id}
                    disabled={moving}
                    onClick={() => void giveItAProject({ project_id: p.id })}
                    className="rounded-inset border border-hairline bg-panel px-3 py-1 text-body text-ink hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            {needsProject.refusal.canCreate && (
              <div className="space-y-work-tight border-t border-hairline pt-work-tight">
                <label className="block text-meta text-ink-quiet">
                  …or start a new one
                  <input
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="what to call it"
                    className="mt-1 block w-full rounded-inset border border-hairline bg-panel px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
                  />
                </label>
                {/* THE NAME OF THE REPO, BEFORE IT EXISTS. Minting one is
                    irreversible and outward-facing; arriving at it by naming a
                    builder mid-sentence is exactly how that happens by
                    accident, so it is shown and agreed to rather than done. */}
                {repoSlug(newProjectName) !== '' && (
                  <p className="text-meta text-ink-quiet">
                    I’ll create the repo <code className="font-mono text-tech text-ink-dim">{repoSlug(newProjectName)}</code> on your GitHub. That’s
                    real and I can’t undo it.
                  </p>
                )}
                <button
                  disabled={moving || repoSlug(newProjectName) === ''}
                  onClick={() => void giveItAProject({ create: { name: newProjectName.trim() } })}
                  className="rounded-inset border border-hairline bg-panel px-3 py-1 text-body text-ink hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
                >
                  {moving ? 'Making it…' : 'Create it and build'}
                </button>
              </div>
            )}

            <button onClick={() => setNeedsProject(null)} className="text-meta text-ink-quiet underline hover:text-ink-dim">
              Not yet — keep talking
            </button>
          </div>
        )}

        {ceiling && (
          <div className="mb-work-tight space-y-work-tight rounded-inset border-2 border-thread bg-panel-soft px-3 py-2">
            <p className="text-body font-medium text-thread">{ceiling.message}</p>
            <p className="font-mono text-tech text-ink-dim">
              {money(ceiling.refusal.spent_cents)} spent of {money(ceiling.refusal.cap_cents)} agreed
              {ceiling.refusal.raises > 0 && ` · raised ${ceiling.refusal.raises}×`}
            </p>
            <div className="flex flex-wrap items-center gap-work">
              <button
                disabled={sending}
                onClick={() => void send(null, false, true)}
                className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
              >
                {raiseLabel(ceiling.refusal)}
              </button>
              <button
                onClick={() => setCeiling(null)}
                className="text-meta text-ink-quiet underline hover:text-ink-dim"
              >
                Leave it here
              </button>
            </div>
          </div>
        )}
        {note && <p className="mb-work-tight rounded-inset border-2 border-thread bg-panel-soft px-3 py-2 text-body font-medium text-thread">{note}</p>}
        {/* What this send is about to do, and what it will cost, BEFORE it is
            pressed. The price used to arrive on the thread afterwards, which
            meant committing in order to find out. */}
        {sendNote(text, roster) && (
          <p className="mb-work-tight font-mono text-tech text-ink-dim">{sendNote(text, roster)}</p>
        )}
        {/* And what it is about to READ. Same principle as the price tag above
            it: what a decision costs belongs in front of the decision. */}
        {referenceNote(text, referenceItems) && (
          <p className="mb-work-tight font-mono text-tech text-ink-quiet">{referenceNote(text, referenceItems)}</p>
        )}
        <form ref={form} onSubmit={(e) => void send(e)} className="relative flex items-end gap-work">
          <ReferenceMenu
            items={referenceItems}
            query={referenceQuery(text)}
            onPick={(name) => {
              setText((current) => completeReference(current, name));
              composerRef.current?.focus();
            }}
            onDismiss={() => setText((current) => current.replace(/(?:^|[^A-Za-z0-9_])#("?)([^"\n]*)$/, (whole, _q: string, typed: string) => whole.slice(0, whole.length - typed.length - 1)))}
          />
          <AgentMenu
            agents={roster}
            query={mentionQuery(text)}
            onPick={pickAgent}
            onDismiss={() => setText((current) => current.replace(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]*)$/, (whole, typed: string) => whole.slice(0, whole.length - typed.length - 1)))}
          />
          <button
            type="button"
            disabled={sending}
            onClick={() => onSwitcherOpenChange(true)}
            title="Choose who answers (Cmd+J)"
            className="rounded-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            <AgentChip agent={data.thread.agent} />
          </button>
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted = pastedImageFiles(e);
              if (pasted.length) {
                e.preventDefault();
                void addImages(pasted, images, setImages, setNote);
                return;
              }
              // A DOCUMENT, NOT A SENTENCE. Past a few thousand characters a
              // paste stops being something you can see past while typing the
              // question about it, so it becomes a chip instead — and gets its
              // own room in the prompt rather than competing with the ask.
              const text = e.clipboardData.getData('text');
              if (!isDocumentSized(text)) return;
              e.preventDefault();
              if (documents.length >= MAX_DOCUMENTS) {
                setNote(TOO_MANY_DOCUMENTS);
                return;
              }
              setDocuments((current) => [...current, { name: nameForPaste(text), text }]);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            rows={1}
            // Never a blocked input: a cold sandbox or a busy agent queues the
            // message, it does not take the composer away.
            disabled={sending}
            placeholder={workshop ? 'What should we build?' : 'What are you thinking about?'}
            className="max-h-56 min-h-[2.5rem] flex-1 resize-none overflow-y-auto rounded-inset border border-hairline bg-panel-soft px-3 py-2 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-60"
          />
          {workshop && data.project && (
            <AttachButtons
              images={images}
              onImagesChange={setImages}
              files={files}
              onFilesChange={setFiles}
              uploadUrl={`/api/projects/${data.project.id}/workshop/uploads`}
              uploading={uploading}
              onUploadingChange={setUploading}
              disabled={sending}
              onError={setNote}
            />
          )}
          <button
            type="submit"
            disabled={sending || text.trim() === '' || uploading}
            className="rounded-inset bg-action px-4 py-2 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            {sending ? 'Sending…' : workshop ? 'Do it' : 'Send'}
          </button>
        </form>
        {/* "Think it through first" was a checkbox here. It is moot: naming a
            talker IS thinking it through, and that costs a keystroke instead of
            a mode. Two ways to do one thing, and the checkbox was the one that
            couldn't also change its mind halfway. */}
        {!data.engine_on && workshop && (
          <p className="mt-work-tight text-meta text-ink-quiet">
            The workshop isn’t switched on here yet: the build engine’s credentials aren’t configured. The watching is unaffected, and talking still works.
          </p>
        )}
      </div>
    </section>
  );
}
