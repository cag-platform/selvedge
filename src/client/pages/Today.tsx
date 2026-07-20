import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

type SectionItem = { project_id: string | null; fragment: string; narration_id: string };

type Digest = {
  id: string;
  digestDate: string;
  headline: string;
  renderedText: string;
  voice?: 'mechanical' | 'composed' | 'fallback';
  sections: {
    attention: SectionItem[];
    moved: SectionItem[];
    standing: string[];
    quiet: string;
    today: string | null;
  };
  createdAt: string;
};

type Narration = {
  id: string;
  projectId: string | null;
  eventId: string;
  eventType: string;
  fragment: string | null;
  technicalDetail: string | null;
  delivery: string;
  occurredAt: string;
};

type TodayResponse = { digest: Digest | null; post_digest_events: Narration[] };

function ExpandableDetail({ eventId, technicalDetail }: { eventId: string; technicalDetail: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 text-sm">
      <button className="text-slate-400 hover:text-slate-600" onClick={() => setOpen((o) => !o)}>
        {open ? 'hide details' : 'details'}
      </button>
      {open && (
        <div className="mt-1 rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500">
          {technicalDetail ?? 'no additional detail'}
          <div className="mt-1 text-slate-400">event id: {eventId}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The two quiet feedback actions every narrated item carries (Phase 2
 * deliverable 5). Deliberately no thumbs-up — absence of complaint is the
 * positive signal.
 */
function FeedbackTaps({ narrationId }: { narrationId: string }) {
  const [state, setState] = useState<'idle' | 'noting' | 'sent'>('idle');
  const [note, setNote] = useState('');

  async function send(kind: 'didnt_help' | 'explain_differently', noteText?: string) {
    try {
      await api.post('/api/feedback', { narration_id: narrationId, kind, ...(noteText ? { note: noteText } : {}) });
    } finally {
      setState('sent');
    }
  }

  if (state === 'sent') return <span className="text-xs text-slate-300">noted</span>;

  if (state === 'noting') {
    return (
      <form
        className="mt-1 flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void send('explain_differently', note);
        }}
      >
        <input
          autoFocus
          className="w-56 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
          placeholder="how should this have been said?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="text-xs text-slate-400 hover:text-slate-600">
          send
        </button>
      </form>
    );
  }

  return (
    <span className="flex gap-3 text-xs text-slate-300">
      <button className="hover:text-slate-500" onClick={() => void send('didnt_help')}>
        didn't help
      </button>
      <button className="hover:text-slate-500" onClick={() => setState('noting')}>
        explain differently
      </button>
    </span>
  );
}

export function Today() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = () =>
    api
      .get<TodayResponse>('/api/today')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const composeNow = async () => {
    setComposing(true);
    setError(null);
    try {
      await api.post('/api/today/compose', {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'compose failed');
    } finally {
      setComposing(false);
    }
  };

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-slate-400">Loading…</p>;

  const { digest, post_digest_events } = data;

  if (!digest) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-slate-600">No digest yet today — the first one composes at your local 7:00am.</p>
        <button
          onClick={() => void composeNow()}
          disabled={composing}
          className="mt-4 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {composing ? 'Composing…' : "Compose today's brief now"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {digest.voice === 'fallback' && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Running with reduced voice today — the narration model wasn't reachable, so this brief was assembled
          mechanically. All facts are unaffected.
        </p>
      )}
      {/* The digest renders as a note, not a table — a deliberate, load-bearing layout choice. */}
      <article className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        {digest.voice === 'composed' ? (
          // The composed brief is one written note — show it verbatim; the
          // mechanical sections below only carry the per-item taps/details.
          <div className="whitespace-pre-line leading-relaxed text-slate-800">{digest.renderedText}</div>
        ) : (
          <p className="text-lg font-medium text-slate-900">{digest.headline}</p>
        )}

        {digest.sections.attention.length > 0 && (
          <section className="mt-5 space-y-4">
            {digest.sections.attention.map((item) => {
              const narration = post_digest_events.find((n) => n.id === item.narration_id);
              return (
                <div key={item.narration_id} className="border-l-2 border-amber-400 pl-3">
                  <p className="text-slate-800">{item.fragment}</p>
                  <ExpandableDetail eventId={narration?.eventId ?? item.narration_id} technicalDetail={narration?.technicalDetail ?? null} />
                  <FeedbackTaps narrationId={item.narration_id} />
                </div>
              );
            })}
          </section>
        )}

        {digest.sections.moved.length > 0 && (
          <section className="mt-5">
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-400">What moved</p>
            <div className="mt-2 space-y-2">
              {digest.sections.moved.map((item) => (
                <div key={item.narration_id}>
                  <p className="text-slate-700">{item.fragment}</p>
                  <FeedbackTaps narrationId={item.narration_id} />
                </div>
              ))}
            </div>
          </section>
        )}

        {digest.sections.standing.length > 0 && (
          <section className="mt-5 space-y-1">
            {digest.sections.standing.map((line, i) => (
              <p key={i} className="text-slate-600">
                {line}
              </p>
            ))}
          </section>
        )}

        {digest.sections.quiet && <p className="mt-5 text-slate-500">{digest.sections.quiet}</p>}

        {digest.sections.today && <p className="mt-5 italic text-slate-700">{digest.sections.today}</p>}
      </article>

      {post_digest_events.filter((n) => n.projectId !== null || n.eventType === 'connector.auth_failed').length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Since this digest</p>
          <div className="space-y-3">
            {post_digest_events.map((n) => (
              <div key={n.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-slate-800">{n.fragment}</p>
                <ExpandableDetail eventId={n.eventId} technicalDetail={n.technicalDetail} />
                <FeedbackTaps narrationId={n.id} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
