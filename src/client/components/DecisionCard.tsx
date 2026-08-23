import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { datingLine, hasBrief, type DatedBrief, type DecisionResponse } from '../lib/decision.js';

/**
 * THE DECISION — the short piece of writing between the two halves of a pair.
 *
 * It sits at the top of the thread rather than in the context panel, because it
 * is not context about the project: it is what this conversation concluded, and
 * a subject thread (which has no panel at all) can have one too.
 *
 * Two things about it are not stylistic:
 *
 * 1. The dating line is never optional and never quiet-when-stale. A brief that
 *    has fallen behind says so in the app's one rationed colour, because a
 *    settled-sounding statement whose settledness nobody checked is the exact
 *    failure this feature was warned about.
 * 2. Open questions are shown, never collapsed away. The temptation is to hide
 *    them as untidy; they are the part that stops a builder from quietly
 *    inventing an answer and calling it the decision.
 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{label}</p>
      {children}
    </div>
  );
}

function EditForm({ dated, onSaved, onCancel }: { dated: DatedBrief; onSaved: (next: DatedBrief) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(dated.brief.title);
  const [decision, setDecision] = useState(dated.brief.decision);
  const [why, setWhy] = useState(dated.brief.why ?? '');
  const [constraints, setConstraints] = useState(dated.brief.constraints.join('\n'));
  const [open, setOpen] = useState(dated.brief.openQuestions.join('\n'));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const lines = (v: string) => v.split('\n').map((l) => l.trim()).filter((l) => l !== '');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      onSaved(
        await api.patch<DatedBrief>(`/api/decisions/${dated.brief.id}`, {
          title,
          decision,
          why,
          constraints: lines(constraints),
          open_questions: lines(open),
        }),
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that didn't save");
      setBusy(false);
    }
  }

  const field = 'w-full rounded-inset border border-hairline bg-panel px-2.5 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright';

  return (
    <form onSubmit={save} className="space-y-work-tight">
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} aria-label="What this is called" />
      <textarea value={decision} onChange={(e) => setDecision(e.target.value)} rows={3} className={field} aria-label="What was decided" />
      <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} className={field} placeholder="Why" aria-label="Why" />
      <textarea
        value={constraints}
        onChange={(e) => setConstraints(e.target.value)}
        rows={2}
        className={field}
        placeholder="It must not break — one per line"
        aria-label="Constraints, one per line"
      />
      <textarea
        value={open}
        onChange={(e) => setOpen(e.target.value)}
        rows={2}
        className={field}
        placeholder="Still open — one per line"
        aria-label="Open questions, one per line"
      />
      {note && <p className="text-meta text-thread">{note}</p>}
      <div className="flex items-center gap-work">
        <button
          type="submit"
          disabled={busy || decision.trim() === ''}
          className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="text-meta text-ink-quiet hover:text-ink-dim">
          Cancel
        </button>
        <p className="text-meta text-ink-quiet">Your words replace mine. This doesn’t change what it was written from.</p>
      </div>
    </form>
  );
}

export function DecisionCard({
  threadId,
  kind,
  hasConversation,
  onOpenThread,
  onReload,
  reloadKey,
}: {
  threadId: string;
  kind: 'workshop' | 'general';
  /** Nothing has been said yet — there is nothing to decide from, so don't offer to. */
  hasConversation: boolean;
  onOpenThread: (id: string) => void;
  onReload: () => void;
  /** Bumped by the thread when its messages change, so the dating re-checks itself. */
  reloadKey: number;
}) {
  const [state, setState] = useState<DecisionResponse | null>(null);
  const [busy, setBusy] = useState<null | 'extract' | 'build'>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<DecisionResponse>(`/api/threads/${threadId}/decision`)
      .then(setState)
      .catch(() => setState({ brief: null }));
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function extract() {
    setBusy('extract');
    setNote(null);
    try {
      setState(await api.post<DatedBrief>(`/api/threads/${threadId}/decision`, {}));
      setEditing(false);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "I couldn't read the conversation back");
    } finally {
      setBusy(null);
    }
  }

  async function build() {
    if (!hasBrief(state)) return;
    setBusy('build');
    setNote(null);
    try {
      const res = await api.post<{ thread: { id: string }; already: boolean }>(`/api/decisions/${state.brief.id}/build`, {});
      onReload();
      onOpenThread(res.thread.id);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setBusy(null);
    }
  }

  // Nothing decided yet. In a thinking thread with something in it, offer to
  // write one down; anywhere else, say nothing at all.
  if (!hasBrief(state)) {
    if (kind !== 'general' || !hasConversation) return null;
    return (
      <div className="border-b border-hairline px-work-loose py-work-tight">
        <button
          onClick={() => void extract()}
          disabled={busy !== null}
          className="text-meta text-ink-quiet hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy === 'extract' ? 'Reading it back…' : 'Write down what we decided — then build it'}
        </button>
        {note && <p className="mt-work-tight text-meta text-thread">{note}</p>}
      </div>
    );
  }

  const { brief, freshness } = state;
  const stale = freshness.state === 'stale';
  const building = brief.buildingThreadId === threadId;

  return (
    <section
      aria-label="The decision"
      className={`border-b px-work-loose py-work ${stale ? 'border-thread bg-panel-soft' : 'border-hairline bg-panel-soft'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-work">
        <p className="text-label font-body uppercase tracking-widest text-ink-quiet">
          {building ? 'Building from this decision' : 'What we decided'}
        </p>
        <div className="flex items-center gap-work">
          {!editing && (
            <>
              <button onClick={() => setEditing(true)} className="text-meta text-ink-quiet hover:text-ink-dim">
                Edit
              </button>
              {/* Re-reading belongs to the thinking side; offering it here as a
                  dead control would only teach that some buttons don't work. */}
              {!building && (
                <button onClick={() => void extract()} disabled={busy !== null} className="text-meta text-ink-quiet hover:text-ink-dim disabled:opacity-50">
                  {busy === 'extract' ? 'Re-reading…' : 'Read it back again'}
                </button>
              )}
            </>
          )}
          {building ? (
            <button onClick={() => onOpenThread(brief.thinkingThreadId)} className="text-meta text-action-bright hover:underline">
              Open the thinking
            </button>
          ) : brief.buildingThreadId ? (
            <button onClick={() => onOpenThread(brief.buildingThreadId!)} className="text-meta text-action-bright hover:underline">
              Open the building
            </button>
          ) : (
            <button
              onClick={() => void build()}
              disabled={busy !== null || !brief.projectId}
              title={brief.projectId ? undefined : "This isn't about a project, so there's no codebase to build it in."}
              className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-50"
            >
              {busy === 'build' ? 'Opening…' : 'Build it'}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-work-tight">
          <EditForm
            dated={state}
            onSaved={(next) => {
              setState(next);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        // A long decision must not push the conversation off the screen: the
        // body scrolls, and the dating line below it never does.
        <div className="mt-work-tight max-h-[32vh] space-y-work-tight overflow-y-auto">
          <p className="text-body-lg font-medium text-ink">{brief.title}</p>
          <p className="whitespace-pre-line text-body text-ink">{brief.decision}</p>
          {brief.why && (
            <Field label="Why">
              <p className="text-body text-ink-dim">{brief.why}</p>
            </Field>
          )}
          {brief.constraints.length > 0 && (
            <Field label="It must not break">
              <ul className="list-disc pl-5 text-body text-ink-dim">
                {brief.constraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Field>
          )}
          {/* Never hidden, never collapsed: the gaps are the point. */}
          {brief.openQuestions.length > 0 && (
            <Field label="Still open — nobody has decided these">
              <ul className="list-disc pl-5 text-body text-ink-dim">
                {brief.openQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </Field>
          )}
        </div>
      )}

      {/* The dating. Always present; in the rationed colour when it matters. */}
      <p className={`mt-work font-mono text-tech ${stale ? 'font-medium text-thread' : 'text-ink-quiet'}`}>
        {datingLine(state)}
        {brief.editedByHuman ? ' · in your words' : ''}
      </p>
      {stale && (
        <p className="mt-1 text-body text-thread">
          {freshness.note}{' '}
          {/* Re-reading only happens where the thinking is — from the building
              side the way through is to go back to it, not to re-extract from a
              conversation this thread isn't having. */}
          {building ? (
            <button onClick={() => onOpenThread(brief.thinkingThreadId)} className="underline hover:no-underline">
              Read the thinking
            </button>
          ) : (
            <button onClick={() => void extract()} disabled={busy !== null} className="underline hover:no-underline disabled:opacity-50">
              {busy === 'extract' ? 'Re-reading…' : 'Read it back again'}
            </button>
          )}
        </p>
      )}
      {note && <p className="mt-work-tight text-meta text-thread">{note}</p>}
    </section>
  );
}
