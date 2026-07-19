import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

type SectionItem = { project_id: string | null; fragment: string; narration_id: string };

type Digest = {
  id: string;
  digestDate: string;
  headline: string;
  renderedText: string;
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

export function Today() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<TodayResponse>('/api/today')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-slate-400">Loading…</p>;

  const { digest, post_digest_events } = data;

  if (!digest) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-slate-600">No digest yet today — the first one composes at your local 7:00am.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* The digest renders as a note, not a table — a deliberate, load-bearing layout choice. */}
      <article className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-lg font-medium text-slate-900">{digest.headline}</p>

        {digest.sections.attention.length > 0 && (
          <section className="mt-5 space-y-4">
            {digest.sections.attention.map((item) => {
              const narration = post_digest_events.find((n) => n.id === item.narration_id);
              return (
                <div key={item.narration_id} className="border-l-2 border-amber-400 pl-3">
                  <p className="text-slate-800">{item.fragment}</p>
                  <ExpandableDetail eventId={narration?.eventId ?? item.narration_id} technicalDetail={narration?.technicalDetail ?? null} />
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
                <p key={item.narration_id} className="text-slate-700">
                  {item.fragment}
                </p>
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
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
