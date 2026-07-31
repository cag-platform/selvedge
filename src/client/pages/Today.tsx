import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Brief, BriefEyebrow, BriefClose, BriefItem, Headline, Reveal } from '../components/Brief.js';
import { StatusDot, type EdgeStatus } from '../components/SelvedgeEdge.js';
import { ProjectRail, type ProjectCardData } from '../components/ProjectRail.js';
import { verdictToStatus, type Verdict } from '../lib/verdict.js';

type SectionItem = {
  project_id: string | null;
  fragment: string;
  narration_id: string;
  verdict?: Verdict | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  technical_detail?: string | null;
  event_id?: string | null;
};

type Correction = { id: string; project_id: string | null; line: string };

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

type TodayResponse = { digest: Digest | null; post_digest_events: Narration[]; corrections?: Correction[] };

/** The pane's own edge carries the day's top priority. */
function briefStatus(digest: Digest): EdgeStatus {
  const verdicts = digest.sections.attention.map((a) => a.verdict).filter((v): v is Verdict => Boolean(v));
  if (verdicts.includes('users_affected')) return 'needs';
  if (digest.sections.attention.length > 0 && verdicts.includes('cannot_tell')) return 'unknown';
  if (digest.sections.attention.length > 0) return 'needs';
  if (digest.sections.moved.length > 0) return 'working';
  return 'healthy';
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

  if (state === 'sent') return <span className="text-meta text-ink-quiet">noted</span>;

  if (state === 'noting') {
    return (
      <form
        className="mt-1 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send('explain_differently', note);
        }}
      >
        <input
          autoFocus
          className="w-60 rounded-inset border border-hairline bg-panel px-2 py-1 text-meta text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
          placeholder="how should this have been said?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="text-meta text-ink-quiet hover:text-ink-dim">
          send
        </button>
      </form>
    );
  }

  return (
    <span className="flex gap-3 text-meta text-ink-quiet">
      <button className="hover:text-ink-dim" onClick={() => void send('didnt_help')}>
        didn't help
      </button>
      <button className="hover:text-ink-dim" onClick={() => setState('noting')}>
        explain differently
      </button>
    </span>
  );
}

function AttentionAnchor({ item }: { item: SectionItem }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-meta text-ink-dim">
      <StatusDot status={item.verdict ? verdictToStatus(item.verdict) : 'needs'} />
      {/* Low confidence is never hidden to look calmer (Ironclad 2). */}
      {item.confidence && item.confidence !== 'high' && (
        <span className="text-ink-quiet">{item.confidence === 'low' ? "not sure — checking" : 'fairly sure'}</span>
      )}
      {(item.technical_detail || item.event_id) && (
        <Reveal>
          {item.technical_detail ?? 'no additional detail'}
          {item.event_id && <div className="mt-1 text-ink-quiet">event id: {item.event_id}</div>}
        </Reveal>
      )}
      <FeedbackTaps narrationId={item.narration_id} />
    </div>
  );
}

export function Today() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [projects, setProjects] = useState<ProjectCardData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = () =>
    Promise.all([
      api.get<TodayResponse>('/api/today').then(setData),
      api.get<ProjectCardData[]>('/api/projects').then(setProjects),
    ]).catch((e: Error) => setError(e.message));

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

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!data) return <p className="text-body text-ink-quiet">Loading…</p>;

  const { digest, post_digest_events } = data;
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  if (!digest) {
    return (
      <div className="animate-settle space-y-8">
        <Brief status="healthy">
          <div>
            <BriefEyebrow>Morning brief · {dateLine}</BriefEyebrow>
            <Headline>Nothing composed yet today.</Headline>
          </div>
          <BriefItem kind="standing">The brief writes itself at your local 7:00am — or now, if you'd like.</BriefItem>
          <button
            onClick={() => void composeNow()}
            disabled={composing}
            className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass disabled:opacity-50"
          >
            {composing ? 'Composing…' : "Compose today's brief now"}
          </button>
        </Brief>
        <ProjectRail projects={projects} />
      </div>
    );
  }

  const composed = digest.voice === 'composed';

  return (
    <div className="animate-settle space-y-8">
      {digest.voice === 'fallback' && (
        <p className="rounded-card border border-hairline bg-panel-soft px-4 py-2 text-body text-ink-dim">
          Running with reduced voice today — this brief was assembled mechanically. All facts are unaffected.
        </p>
      )}

      {/* Own the miss out loud (Ironclad 2): a false all-clear, corrected. */}
      {data.corrections && data.corrections.length > 0 && (
        <div className="rounded-card border border-hairline border-l-2 border-l-thread bg-panel-soft px-4 py-3">
          <p className="text-label font-body uppercase tracking-widest text-thread">Correcting myself</p>
          {data.corrections.map((c) => (
            <p key={c.id} className="mt-1 text-body text-ink">
              {c.line}
            </p>
          ))}
        </div>
      )}

      <Brief status={briefStatus(digest)}>
        <div>
          <BriefEyebrow>Morning brief · {dateLine}</BriefEyebrow>
          {!composed && <Headline>{digest.headline}</Headline>}
        </div>

        {composed ? (
          <>
            {/* The composed brief is one written note — verbatim. */}
            <div className="whitespace-pre-line text-body-lg leading-relaxed text-ink">{digest.renderedText}</div>
            {digest.sections.attention.length > 0 && (
              <div className="space-y-2 border-t border-hairline pt-3">
                {digest.sections.attention.map((item) => (
                  <AttentionAnchor key={item.narration_id} item={item} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {digest.sections.attention.map((item) => (
              <BriefItem
                key={item.narration_id}
                kind="attention"
                verdict={item.verdict ?? undefined}
                reveal={
                  (item.technical_detail || item.event_id) && (
                    <Reveal>
                      {item.technical_detail ?? 'no additional detail'}
                      {item.event_id && <div className="mt-1 text-ink-quiet">event id: {item.event_id}</div>}
                    </Reveal>
                  )
                }
                actions={<FeedbackTaps narrationId={item.narration_id} />}
              >
                {item.fragment}
              </BriefItem>
            ))}
            {digest.sections.moved.map((item) => (
              <BriefItem key={item.narration_id} kind="moved" actions={<FeedbackTaps narrationId={item.narration_id} />}>
                {item.fragment}
              </BriefItem>
            ))}
            {digest.sections.standing.map((line, i) => (
              <BriefItem key={i} kind="standing">
                {line}
              </BriefItem>
            ))}
            {digest.sections.quiet && <BriefClose>{digest.sections.quiet}</BriefClose>}
            {digest.sections.today && <BriefItem kind="standing">{digest.sections.today}</BriefItem>}
          </>
        )}
      </Brief>

      {post_digest_events.filter((n) => n.projectId !== null || n.eventType === 'connector.auth_failed').length > 0 && (
        <section>
          <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Since this brief</p>
          <div className="space-y-3">
            {post_digest_events.map((n) => (
              <div key={n.id} className="relative rounded-card border border-hairline bg-panel p-4 pl-5">
                <p className="text-body text-ink">{n.fragment}</p>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {n.technicalDetail && (
                    <Reveal>
                      {n.technicalDetail}
                      <div className="mt-1 text-ink-quiet">event id: {n.eventId}</div>
                    </Reveal>
                  )}
                  <FeedbackTaps narrationId={n.id} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ProjectRail projects={projects} />

      {/* The independent-auditor stance, stated plainly (Ironclad 2). */}
      <p className="text-meta text-ink-quiet">
        Selvedge didn't build your apps. That's the point — I have no reason to tell you everything's fine when it isn't.
      </p>
    </div>
  );
}
