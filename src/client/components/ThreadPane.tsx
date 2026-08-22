import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatCents } from '../lib/ledger.js';
import { describeToolEvent, summarizeRecord, type RunRecordView } from '../lib/replay.js';
import { Reveal } from './Brief.js';
import { AgentChip } from './AgentChip.js';
import { AgentMenu } from './AgentMenu.js';
import { completeMention, mentionQuery, sendNote, type AgentOffer, type RosterResponse } from '../lib/agents.js';
import { PendingChips, AttachButtons, pastedImageFiles, addImages, addDocs, type PendingImage, type PendingFile } from './WorkshopAttach.js';
import { DecisionCard } from './DecisionCard.js';
import { staleRefusalOf, type StaleRefusal } from '../lib/decision.js';
import type { ThreadData, ThreadMessage } from '../lib/inbox.js';

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
        <p className="text-body text-ink">There's finished work here that isn't live yet.</p>
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
    <div className={message.role === 'owner' ? 'pl-6' : 'border-l-2 border-hairline pl-work'}>
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{message.role === 'owner' ? 'You' : 'Selvedge'}</p>
      <p className="whitespace-pre-line text-body text-ink">{message.content}</p>
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
   * Who could answer, and what handing it to each would cost — quoted by the
   * server before anything is handed over. Re-read when the answering agent
   * changes, because a handover's size depends on who it is coming from.
   */
  const [roster, setRoster] = useState<AgentOffer[]>([]);
  const [planFirst, setPlanFirst] = useState(false);
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
  const end = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const workshop = data.thread.kind === 'workshop';

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, composerRef]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data.messages.length]);

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

  // A turn that has started clears the "getting ready" line — the thread is
  // moving again, and saying it twice would be noise.
  useEffect(() => {
    if (data.working) setWarming(false);
  }, [data.working]);

  /**
   * `acknowledgeStale` is only ever true because a person pressed the second
   * button, having read what they were overriding. It is never carried over
   * from a previous send, and never defaulted on.
   */
  async function send(e: React.FormEvent | null, acknowledgeStale = false) {
    e?.preventDefault();
    const body = text.trim();
    if (body === '' || uploading) return;
    setSending(true);
    setNote(null);
    try {
      const res = await api.post<{ started: boolean; warming: boolean }>(`/api/threads/${data.thread.id}/message`, {
        text: body,
        ...(workshop && planFirst ? { mode: 'plan' } : {}),
        ...(images.length ? { images: images.map((i) => ({ mime: i.mime, dataBase64: i.dataBase64 })) } : {}),
        ...(files.length ? { files: files.map((f) => ({ id: f.id })) } : {}),
        ...(acknowledgeStale ? { acknowledge_stale: true } : {}),
      });
      setText('');
      setImages([]);
      setFiles([]);
      setPlanFirst(false);
      setStaleRefusal(null);
      setWarming(res.warming);
      onReload();
    } catch (err) {
      // A stale decision is a refusal with a way through, not a dead end: keep
      // what was typed, say what is behind, and let the owner choose. The
      // message is NOT sent by the act of being told.
      const refusal = err instanceof ApiError && err.status === 409 ? staleRefusalOf(err.body) : null;
      if (refusal) setStaleRefusal({ refusal, message: err instanceof Error ? err.message : '' });
      else setNote(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setSending(false);
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
      <header className="flex flex-wrap items-baseline justify-between gap-work border-b border-hairline px-work-loose py-work">
        <div className="min-w-0">
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
              className="w-full rounded-inset border border-hairline bg-panel-soft px-2 py-1 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            />
          ) : (
            <button onClick={() => setRenaming(true)} title="Rename this thread" className="truncate text-body font-medium text-ink hover:text-ink-dim">
              {data.thread.title}
            </button>
          )}
          <p className="truncate text-meta text-ink-quiet">
            {data.project?.name ?? data.subject?.name ?? 'unfiled'} ·{' '}
            {workshop ? 'builds in the sandbox' : data.project ? 'chat, nothing is built here' : 'a conversation about a subject, not a codebase'}
          </p>
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
        onOpenThread={onOpenThread}
        onReload={onReload}
        reloadKey={data.messages.length}
      />

      <div className="flex-1 space-y-work-loose overflow-y-auto px-work-loose py-work">
        {data.messages.length === 0 && (
          <p className="text-body text-ink-quiet">
            {workshop
              ? 'Say what you want in plain words — "add a contact form", "fix the broken checkout button". I build it in the sandbox and you see it before anything goes live.'
              : 'Think out loud here. Nothing gets built in this thread — it is for deciding what to build, and it stays with the project so you never explain it twice.'}
          </p>
        )}
        {data.messages.map((m) => (
          <Message key={m.id} message={m} data={data} />
        ))}
        {data.working && (
          <div className="border-l-2 border-brass pl-work">
            <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge</p>
            <p className="text-body text-ink-dim">Working on it…</p>
          </div>
        )}
        {warming && !data.working && (
          <p className="font-mono text-tech text-ink-quiet">
            {data.thread.agent === 'codex' ? 'Codex' : 'The workshop'} is getting ready — your message is queued.
          </p>
        )}
        <div ref={end} />
      </div>

      {workshop && data.project && data.staged_changes_ready && (
        <ShipControls data={{ ...data, project: data.project }} onDone={onReload} />
      )}

      <div className="border-t border-hairline px-work-loose py-work">
        <PendingChips images={images} onImagesChange={setImages} files={files} onFilesChange={setFiles} />
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
        {note && <p className="mb-work-tight rounded-inset border-2 border-thread bg-panel-soft px-3 py-2 text-body font-medium text-thread">{note}</p>}
        {/* What this send is about to do, and what it will cost, BEFORE it is
            pressed. The price used to arrive on the thread afterwards, which
            meant committing in order to find out. */}
        {sendNote(text, roster) && (
          <p className="mb-work-tight font-mono text-tech text-ink-dim">{sendNote(text, roster)}</p>
        )}
        <form ref={form} onSubmit={(e) => void send(e)} className="relative flex items-end gap-work">
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
              }
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
            {sending ? 'Sending…' : planFirst ? 'Think it through' : workshop ? 'Do it' : 'Send'}
          </button>
        </form>
        {workshop && (
          <label className="mt-work-tight flex cursor-pointer items-center gap-2 text-meta text-ink-quiet">
            <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} disabled={sending} className="accent-action-bright" />
            Think it through first — talk it over, build nothing yet
          </label>
        )}
        {!data.engine_on && workshop && (
          <p className="mt-work-tight text-meta text-ink-quiet">
            The workshop isn't switched on here yet — the build engine's credentials aren't configured. The watching and your brief are unaffected.
          </p>
        )}
      </div>
    </section>
  );
}
