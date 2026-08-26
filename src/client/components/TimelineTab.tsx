import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Reveal } from './Reveal.js';
import { SelvedgeEdge } from './SelvedgeEdge.js';
import { whenShort } from '../lib/inbox.js';
import { LockedOlder } from './UpgradeNote.js';
import { EmptyState } from './ui.js';
import type { DeepLinkDestination } from '../../shared/types/continuation.js';
import type { EvidenceSheet } from '../../shared/types/evidenceSheet.js';

/**
 * WHAT HAPPENED TO THIS PROJECT — the record, finally with a face.
 *
 * Everything here already existed: the asks, the ships, the undos, the
 * verdicts, the handovers, and what the watching saw. It was all in the
 * database and none of it was anywhere a person could read it. One scrollable
 * list, one plain sentence per thing, the same status edge the rest of the
 * product uses, and the evidence one click beneath — the test being that you
 * can answer "what happened here in the last two weeks?" without opening a
 * single conversation.
 *
 * It is a READING surface inside a working one, so it keeps the airy register
 * (--space-read) while the panel's chrome around it stays compact.
 */

type Entry = {
  id: string;
  at: string;
  kind: string;
  sentence: string;
  status: 'healthy' | 'working' | 'needs' | 'unknown';
  evidence: string[];
  ref: { thread_id?: string; card_id?: string; run_id?: string; commit?: string };
  destination?: DeepLinkDestination;
};

type Hit = {
  kind: 'message' | 'card' | 'event';
  at: string;
  where: string;
  excerpt: string;
  ref: { thread_id?: string; card_id?: string };
};

export function TimelineTab({ projectId, onOpenThread }: { projectId: string; onOpenThread: (threadId: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How much of the record this plan is holding back — on the list and on the
  // search separately, because they are cut short independently.
  const [lockedEntries, setLockedEntries] = useState(0);
  const [lockedHits, setLockedHits] = useState(0);
  const [evidence, setEvidence] = useState<{ entryId: string; sheet: EvidenceSheet } | null>(null);

  const load = useCallback(() => {
    setEntries(null);
    api
      .get<{ entries: Entry[]; repo_url: string | null; locked_older_count?: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/timeline?days=${days}`,
      )
      .then((r) => {
        setEntries(r.entries);
        setRepoUrl(r.repo_url);
        setLockedEntries(r.locked_older_count ?? 0);
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, days]);

  useEffect(() => {
    load();
  }, [load]);

  // Search as you type, but only once you have typed something worth
  // searching for — a one-letter query matches everything, which is the same
  // as matching nothing.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ hits: Hit[]; locked_older_count?: number }>(`/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setHits(r.hits);
          setLockedHits(r.locked_older_count ?? 0);
        })
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, projectId]);

  const openEvidence = useCallback(async (entry: Entry) => {
    const destination = entry.destination;
    if (!destination) return;
    const path = destination.run_id
      ? `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(destination.run_id)}/evidence`
      : destination.card_id
        ? `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(destination.card_id)}/evidence`
        : null;
    if (!path) return;
    try {
      const sheet = await api.get<EvidenceSheet>(path);
      setEvidence({ entryId: entry.id, sheet });
      window.history.replaceState(null, '', destination.web_path);
    } catch (e) { setError(e instanceof Error ? e.message : "I couldn't load that evidence."); }
  }, [projectId]);

  useEffect(() => {
    if (!entries || evidence) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('run') ?? params.get('card');
    const entry = entries.find((item) => item.destination?.run_id === id || item.destination?.card_id === id);
    if (entry) void openEvidence(entry);
  }, [entries, evidence, openEvidence]);

  return (
    <div className="space-y-work">
      <div className="flex items-center gap-work-tight">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this project"
          aria-label="Search this project"
          className="min-w-0 flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-meta text-ink-quiet hover:text-ink-dim">
            Clear
          </button>
        )}
      </div>

      {error && <p className="text-body text-thread">{error}</p>}

      {hits !== null && hits.length === 0 ? (
        // What the search DOESN'T cover is the useful half of this sentence:
        // somebody searching a project for a function name needs to know they
        // are looking in the wrong place, not that their project is empty.
        <EmptyState
          action={
            <button onClick={() => setQuery('')} className="text-meta text-action-bright hover:underline">
              Clear the search
            </button>
          }
        >
          Nothing in {projectId} matches &lsquo;{query.trim()}&rsquo;. Search covers every thread, ask, and event in
          this project &mdash; not the code itself.
          {/* The one thing worse than finding nothing is finding nothing while
              matches sit behind a plan window nobody mentioned. */}
          <LockedOlder count={lockedHits} />
        </EmptyState>
      ) : hits !== null ? (
        <div className="space-y-read">
          <p className="text-meta text-ink-quiet">
            {hits.length} {hits.length === 1 ? 'thing mentions' : 'things mention'} that.
          </p>
          <LockedOlder count={lockedHits} />
          {hits.map((hit, i) => (
            <button
              key={`${hit.at}-${i}`}
              onClick={() => hit.ref.thread_id && onOpenThread(hit.ref.thread_id)}
              disabled={!hit.ref.thread_id}
              className="block w-full rounded-inset px-work-tight py-work-tight text-left hover:bg-panel-soft disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            >
              <p className="text-meta text-ink-quiet">
                {hit.where} · {whenShort(hit.at)}
              </p>
              <p className="text-body text-ink-dim">{hit.excerpt}</p>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{days === 0 ? 'Everything so far' : 'The last two weeks'}</p>
            <button onClick={() => setDays(days === 0 ? 14 : 0)} className="text-meta text-ink-quiet hover:text-ink-dim">
              {days === 0 ? 'Just the fortnight' : 'Show everything'}
            </button>
          </div>

          {entries === null && <p className="text-body text-ink-quiet">Loading…</p>}
          {entries?.length === 0 && (
            <EmptyState>
              {lockedEntries > 0
                ? 'Nothing in the last thirty days. The record before that is still here.'
                : 'Nothing has happened here yet. The first message, ship, or deploy starts the record.'}
              <LockedOlder count={lockedEntries} />
            </EmptyState>
          )}

          <ol className="space-y-read">
            {entries?.map((entry) => (
              <li key={entry.id} className="relative pl-work">
                <SelvedgeEdge status={entry.status} />
                <p className="text-meta text-ink-quiet">{whenShort(entry.at)}</p>
                <p className="text-body text-ink">{entry.sentence}</p>
                {entry.evidence.length > 0 && (
                  <Reveal summary="what that rests on">
                    {entry.evidence.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </Reveal>
                )}
                <div className="mt-work-tight flex flex-wrap gap-work">
                  {entry.destination && (
                    <button onClick={() => void openEvidence(entry)} className="text-meta text-action-bright hover:underline">View evidence sheet</button>
                  )}
                  {entry.ref.thread_id && (
                    <button onClick={() => onOpenThread(entry.ref.thread_id!)} className="text-meta text-action-bright hover:underline">
                      Open the conversation
                    </button>
                  )}
                  {/* The change itself, when the entry knows which commit it was. */}
                  {entry.ref.commit && repoUrl && (
                    <a
                      href={`${repoUrl.replace(/\/+$/, '')}/commit/${entry.ref.commit}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-meta text-action-bright hover:underline"
                    >
                      See the change
                    </a>
                  )}
                </div>
                {evidence?.entryId === entry.id && <TimelineEvidence sheet={evidence.sheet} />}
              </li>
            ))}
          </ol>

          {/* The end of the list is where "there is more" belongs — a
              window that silently returns fewer rows is the same lie as a
              truncated list that does not say it truncated. */}
          <LockedOlder count={lockedEntries} />

          {/* The honest part, said out loud: this is the same record the export
              carries, and being able to leave is what makes it worth staying. */}
          <p className="border-t border-hairline pt-work text-meta text-ink-quiet">
            This is your record — the same history{' '}
            <a href="/api/export" className="text-action-bright hover:underline">
              your export
            </a>{' '}
            carries, in the same words.
          </p>
        </>
      )}
    </div>
  );
}

function TimelineEvidence({ sheet }: { sheet: EvidenceSheet }) {
  return <div className="mt-3 rounded-inset border border-hairline bg-panel-soft p-3 text-meta text-ink-dim">
    <p className="text-body font-medium text-ink">{sheet.summary}</p>
    <p>{sheet.explanation}</p>
    <p className="mt-2">{sheet.changed_files.total} changed file{sheet.changed_files.total === 1 ? '' : 's'} · {sheet.checks_run.length} completed check{sheet.checks_run.length === 1 ? '' : 's'}</p>
    <p>Acceptance: {sheet.acceptance_observation ? `${sheet.acceptance_observation.outcome} — ${sheet.acceptance_observation.name}` : 'not recorded'}</p>
    {sheet.unavailable_checks.map((check, index) => <p key={`${check.name}-${index}`}>Unavailable: {check.name}{check.detail ? ` — ${check.detail}` : ''}</p>)}
    {sheet.warnings.map((warning) => <p key={warning} className="text-thread">{warning}</p>)}
    <Reveal summary="Raw evidence">
      {sheet.raw_evidence.tools.map((tool) => <div key={tool.id}>{tool.detail}{tool.ok === undefined ? '' : tool.ok ? ' · ok' : ` · failed${tool.note ? ` — ${tool.note}` : ''}`}</div>)}
      {sheet.raw_evidence.acts.map((act, index) => <div key={`${act.at}-${index}`}>{act.at} · {act.kind} · {act.detail}</div>)}
      {!sheet.raw_evidence.tools.length && !sheet.raw_evidence.acts.length && <p>No raw steps were recorded.</p>}
    </Reveal>
  </div>;
}
