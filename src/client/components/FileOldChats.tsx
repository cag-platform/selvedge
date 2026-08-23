import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Pane } from './ui.js';

/**
 * THE PILE, AND A WAY THROUGH IT.
 *
 * An import lands a year of conversations under one heading and stops. That is
 * where "bring your history and continue building" used to end — everything
 * in, nothing anywhere, and no way to join a conversation about Loom to the
 * project called Loom.
 *
 * This screen is the join. It is a LIST OF SUGGESTIONS, not a queue of
 * decisions already made: each row says which project it looks like and shows
 * the words it matched on, and nothing moves until a person says so. One tap
 * files it, one tap dismisses it for this session, and a conversation nobody
 * touches stays exactly where it was.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER. There is no "file all". Reviewing forty
 * suggestions one at a time is the work; a button that skips the reviewing is
 * a button that files the wrong ones too, and the person who pressed it will
 * never know which.
 */

type Suggestion = {
  thread_id: string;
  title: string;
  at: string | null;
  message_count: number;
  project_id: string;
  project_name: string;
  because: string[];
  matched_in: 'title' | 'text';
};

type Review = {
  unfiled: number;
  ambiguous: number;
  suggestions: Suggestion[];
  note: string | null;
};

function when(at: string | null): string {
  if (!at) return '';
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function FileOldChats() {
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState<Record<string, 'filed' | 'skipped'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Review>('/api/import/filing')
      .then(setReview)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="text-body text-thread">{error}</p>;
  // Nothing imported, or nothing left to look at: no panel at all. An empty
  // panel saying "no suggestions" is a thing to read on every visit forever.
  if (!review || review.unfiled === 0) return null;

  const open = review.suggestions.filter((s) => !done[s.thread_id]);
  const filed = Object.values(done).filter((d) => d === 'filed').length;

  async function file(suggestion: Suggestion) {
    setBusy(suggestion.thread_id);
    setError(null);
    try {
      await api.post(`/api/threads/${suggestion.thread_id}/file`, { project_id: suggestion.project_id });
      setDone((d) => ({ ...d, [suggestion.thread_id]: 'filed' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't move");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Pane className="mt-3">
      <p className="text-body text-ink">Old chats that look like they belong to a project</p>
      <p className="mt-1 text-meta text-ink-quiet">
        {review.suggestions.length === 0
          ? `${review.unfiled} imported ${review.unfiled === 1 ? 'conversation is' : 'conversations are'} filed under no project, and none of them names one.`
          : `${review.suggestions.length} of your ${review.unfiled} imported conversations name a project you have. Filing one moves it into that project's history — it keeps its date, and it stays marked as imported.`}
      </p>
      {/* Said next to what the list CAN do. Most of a personal history is not
          about a codebase, and a screen that implied otherwise would be
          inventing work rather than saving it. */}
      {review.note && <p className="mt-1 text-meta text-ink-quiet">{review.note}</p>}
      {review.ambiguous > 0 && (
        <p className="mt-1 text-meta text-ink-quiet">
          {review.ambiguous} more {review.ambiguous === 1 ? 'names' : 'name'} two projects at once, so {review.ambiguous === 1 ? 'it is' : 'they are'} not
          suggested here — file {review.ambiguous === 1 ? 'it' : 'them'} from the conversation itself.
        </p>
      )}

      {open.length > 0 && (
        <ul className="mt-work space-y-work-tight">
          {open.map((s) => (
            <li key={s.thread_id} className="rounded-card border border-hairline bg-panel-soft px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-body text-ink">{s.title}</p>
                <p className="font-mono text-tech text-ink-quiet">
                  {when(s.at)} · {s.message_count} {s.message_count === 1 ? 'message' : 'messages'}
                </p>
              </div>
              {/* THE EVIDENCE, NOT A SCORE. A person deciding where their own
                  history goes should be reading why, not trusting how much. */}
              <p className="mt-1 text-meta text-ink-quiet">
                Looks like <span className="text-ink-dim">{s.project_name}</span> — {s.matched_in === 'title' ? 'the title says' : 'it mentions'}{' '}
                {s.because.map((b) => `“${b}”`).join(', ')}.
              </p>
              <div className="mt-2 flex items-center gap-work">
                <button
                  onClick={() => void file(s)}
                  disabled={busy === s.thread_id}
                  className="rounded-inset border border-hairline bg-panel px-3 py-1 text-body text-ink hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
                >
                  {busy === s.thread_id ? 'Filing…' : `File under ${s.project_name}`}
                </button>
                <button
                  onClick={() => setDone((d) => ({ ...d, [s.thread_id]: 'skipped' }))}
                  className="text-meta text-ink-quiet hover:text-ink-dim"
                >
                  Leave it
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {filed > 0 && (
        <p className="mt-work text-meta text-ink-quiet">
          {filed} {filed === 1 ? 'conversation is' : 'conversations are'} now in {filed === 1 ? 'its' : 'their'} project. Open the project to
          find {filed === 1 ? 'it' : 'them'} in the history.
        </p>
      )}
      {open.length === 0 && filed === 0 && <p className="mt-work text-meta text-ink-quiet">Nothing left to look at here.</p>}
    </Pane>
  );
}
