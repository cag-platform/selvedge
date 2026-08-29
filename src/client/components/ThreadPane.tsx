import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { formatCents } from '../lib/ledger.js';
import {
  describeToolEvent,
  simpleActivitySummary,
  technicalActivitySummary,
  type RunRecordView,
} from '../lib/replay.js';
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
import { BuilderHandoff } from './BuilderHandoff.js';
import { OpinionComparison } from './OpinionComparison.js';
import { needsOwner, type WorkCardData } from '../lib/card.js';
import { groupPairedConsultations } from '../lib/consultation.js';
import type { LiveReply } from '../pages/Inbox.js';
import type { GeneratedVisual, ThreadData, ThreadMessage } from '../lib/inbox.js';
import type { TechnicalDetail } from '../../shared/technicalDetail.js';
import type { EvidenceSheet } from '../../shared/types/evidenceSheet.js';
import type { MigrationJourney } from '../../shared/types/migration.js';
import { SelvedgeEdge } from './SelvedgeEdge.js';

type ContextReceipt = { sections: { about: string[]; recent: string[]; open: string[] } };

function MigrationJourneyPanel({ projectId, working }: { projectId: string; working: boolean }) {
  const [journey, setJourney] = useState<MigrationJourney | null>(null);
  const [hosting, setHosting] = useState('owner');
  const [database, setDatabase] = useState('owner');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get<MigrationJourney>(`/api/projects/${encodeURIComponent(projectId)}/migration`).then((loaded) => {
      setJourney(loaded);
      if (loaded.destinations.hosting) setHosting(loaded.destinations.hosting);
      if (loaded.destinations.database) setDatabase(loaded.destinations.database);
    }).catch(() => setJourney(null));
  }, [projectId, working]);
  if (!journey) return null;
  const found = journey.project_map.items.filter((item) => item.status === 'found');
  const access = journey.project_map.items.filter((item) => item.status === 'needs_access');
  return <section className="border-b border-hairline bg-sage px-work-loose py-work" aria-label="Migration project map">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="section-label">Migration · {working ? 'agents working' : journey.state.replaceAll('_', ' ')}</p><h2 className="mt-1 font-display text-xl text-ink">Selvedge inspected {journey.project_map.files_inspected} files.</h2><p className="mt-1 text-meta text-ink-dim">{journey.project_map.stack.length ? journey.project_map.stack.join(' · ') : 'Stack not identified yet'} · original environment untouched</p></div><span className="rounded-full bg-panel px-3 py-1.5 font-mono text-tech text-ink-dim">{found.length} observed · {access.length} need access</span></div>
    <div className="mt-3 flex flex-wrap gap-2">{journey.project_map.items.map((item) => <span key={item.kind} title={item.note} className={`rounded-full border px-2.5 py-1 text-meta ${item.status === 'found' ? 'border-healthy/40 text-ink' : item.status === 'needs_access' ? 'border-brass/50 text-ink-dim' : 'border-hairline text-ink-quiet'}`}>{item.status === 'found' ? '✓' : item.status === 'needs_access' ? '○' : '–'} {item.label}</span>)}</div>
    <details className="mt-3 rounded-inset border border-hairline bg-panel-soft p-3" open><summary className="cursor-pointer text-meta font-medium text-ink">Migration plan · {journey.migration_plan.steps.filter((step) => step.state === 'complete').length}/{journey.migration_plan.steps.length} complete</summary><ol className="mt-3 grid gap-2">{journey.migration_plan.steps.map((step, index) => <li key={step.id} className="flex gap-3 text-meta"><span className="font-mono text-tech text-ink-quiet">{String(index + 1).padStart(2, '0')}</span><span className="min-w-0 flex-1"><strong className="font-medium text-ink">{step.label}</strong><span className="ml-2 text-ink-quiet">{step.state.replaceAll('_', ' ')}</span><p className="text-ink-dim">{step.detail}</p>{step.blockers.map((blocker) => <p key={blocker} className="text-brass">Needs you: {blocker}</p>)}</span><span className="font-mono text-tech text-ink-quiet">{step.owner.replaceAll('_', ' ')}</span></li>)}</ol><p className="mt-3 border-t border-hairline pt-3 text-meta text-ink-dim"><strong className="text-ink">Next:</strong> {journey.migration_plan.next_action}</p></details>
    {journey.preview.state === 'ready' && journey.preview.url && <div className="mt-3 overflow-hidden rounded-card border border-hairline bg-panel"><div className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2"><span className="text-meta font-medium text-ink">Migrated app · live development preview</span><a href={journey.preview.url} target="_blank" rel="noreferrer" className="text-meta text-action-bright hover:underline">Open larger ↗</a></div><iframe src={journey.preview.url} title="Migrated app live preview" className="h-[360px] w-full bg-white" /></div>}
    {journey.preview.state === 'error' && <p className="mt-3 rounded-inset border border-brass/40 bg-panel-soft px-3 py-2 text-meta text-ink-dim"><strong className="text-ink">Preview needs configuration:</strong> {journey.preview.message}</p>}
    <details className="mt-3"><summary className="cursor-pointer text-meta text-action-bright">Choose where the migrated app should live</summary><div className="mt-3 flex flex-wrap items-end gap-3"><label className="text-meta text-ink-dim">Hosting<select value={hosting} onChange={(event) => setHosting(event.target.value)} className="mt-1 block rounded-inset border border-hairline bg-panel px-3 py-2 text-body text-ink"><option value="owner">My connected account</option><option value="railway">Railway</option><option value="vercel">Vercel</option><option value="cloudflare">Cloudflare</option></select></label><label className="text-meta text-ink-dim">Database<select value={database} onChange={(event) => setDatabase(event.target.value)} className="mt-1 block rounded-inset border border-hairline bg-panel px-3 py-2 text-body text-ink"><option value="owner">My connected database</option><option value="neon">Neon</option><option value="supabase">Supabase</option></select></label><button type="button" disabled={saving} onClick={async () => { setSaving(true); try { setJourney(await api.patch<MigrationJourney>(`/api/projects/${encodeURIComponent(projectId)}/migration/destinations`, { hosting, database })); } finally { setSaving(false); } }} className="rounded-inset bg-action px-4 py-2 text-body font-medium text-ink disabled:opacity-50">{saving ? 'Saving…' : 'Use these destinations'}</button></div><p className="mt-2 text-meta text-ink-quiet">This records intent only. Selvedge will request the relevant account connection before provisioning or moving data.</p></details>
  </section>;
}

function ReceivedContext({ projectId, showReceipt }: { projectId: string; showReceipt: boolean }) {
  const [received, setReceived] = useState<ContextReceipt | null>(null);
  useEffect(() => {
    api.get<ContextReceipt>(`/api/projects/${encodeURIComponent(projectId)}/context`).then(setReceived).catch(() => setReceived(null));
  }, [projectId]);
  if (!received) return null;
  const count = received.sections.about.length + received.sections.recent.length + received.sections.open.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-dim" aria-label="Caught up on this project">
      <span className="font-medium text-action-bright">Caught up on this project</span>
      {showReceipt && <>
        <span aria-hidden>·</span><span>{count} grounded lines</span>
        <span aria-hidden>·</span><span>{received.sections.recent.length} recent records</span>
        <span aria-hidden>·</span><span>{received.sections.open.length} open questions</span>
        <span aria-hidden>·</span><span>repository access reported per answer</span>
      </>}
    </span>
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

function ShipControls({ data, onDone, prompted = false, branch, onReview, onCancel }: {
  data: ThreadData & { project: { id: string; name: string } };
  onDone: () => void;
  prompted?: boolean;
  branch?: string;
  onReview?: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [needsBackup, setNeedsBackup] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceSheet | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const lastShip = data.runs.find((r) => r.kind === 'ship' && r.commit)?.commit ?? null;
  const latestEvidence = [...data.runs]
    .filter((run) => run.evidence)
    .sort((a, b) => b.at.localeCompare(a.at))[0]?.evidence ?? null;
  const repository = data.console_links?.find((link) => /github|repository|repo/i.test(`${link.provider} ${link.label}`)) ?? null;

  useEffect(() => {
    if (!latestEvidence) { setEvidence(null); setEvidenceError(null); return; }
    let active = true;
    setEvidenceBusy(true);
    setEvidenceError(null);
    api.get<EvidenceSheet>(latestEvidence.path)
      .then((sheet) => { if (active) setEvidence(sheet); })
      .catch((error) => { if (active) setEvidenceError(error instanceof Error ? error.message : 'Evidence is unavailable.'); })
      .finally(() => { if (active) setEvidenceBusy(false); });
    return () => { active = false; };
  }, [latestEvidence?.path]);

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
      <div className="flex flex-wrap items-start justify-between gap-work border-b border-hairline pb-work-tight">
        <div className="max-w-2xl">
          <p className="section-label">Review and ship</p>
          <p className="mt-1 text-body font-medium text-ink">{prompted ? 'Selvedge has prepared the requested change.' : 'There’s finished work here that isn’t live yet.'}</p>
          <p className="mt-1 text-meta text-ink-dim">Review what was observed below. Shipping commits the workspace and pushes it to {branch ?? 'the project branch'}{repository ? ` in ${repository.label}` : ''}. If hosting follows that branch, deployment begins.</p>
        </div>
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
          {prompted && onCancel && <button type="button" disabled={busy} onClick={onCancel} className="text-meta text-ink-quiet hover:text-ink-dim disabled:opacity-50">Not yet</button>}
        </div>
      </div>
      <div className="grid gap-work md:grid-cols-2">
        <div className="relative rounded-inset border border-hairline bg-panel px-3 py-3 pl-work">
          <p className="text-label uppercase tracking-widest text-ink-quiet">Observed result</p>
          {evidenceBusy && <p className="mt-2 text-meta text-ink-dim">Reading the recorded evidence…</p>}
          {evidenceError && <p className="mt-2 text-meta text-thread">{evidenceError}</p>}
          {!latestEvidence && <p className="mt-2 text-meta text-ink-dim">No verification record is attached. Selvedge cannot claim this change passed.</p>}
          {evidence && <>
            <div className="mt-2 flex items-start gap-2"><SelvedgeEdge status={evidence.status} /><div><p className="text-body font-medium text-ink">{evidence.summary}</p><p className="text-meta text-ink-dim">{evidence.explanation}</p></div></div>
            <p className="mt-3 text-meta font-medium text-ink">Changed files · {evidence.changed_files.total}</p>
            {evidence.changed_files.paths.length > 0 ? <ul className="mt-1 max-h-24 overflow-auto font-mono text-tech text-ink-dim">{evidence.changed_files.paths.map((path) => <li key={path}>{path}</li>)}</ul> : <p className="mt-1 text-meta text-ink-dim">No changed-file list was recorded.</p>}
          </>}
        </div>
        <div className="rounded-inset border border-hairline bg-panel px-3 py-3">
          <p className="text-label uppercase tracking-widest text-ink-quiet">Checks and limitations</p>
          {evidence && <>
            {evidence.checks_run.length > 0 ? <ul className="mt-2 space-y-1 text-meta text-ink-dim">{evidence.checks_run.map((check, index) => <li key={`${check.name}-${index}`}><span className={check.outcome === 'passed' ? 'text-healthy' : 'text-thread'}>{check.outcome === 'passed' ? '✓' : '×'}</span> {check.name}{check.detail ? ` — ${check.detail}` : ''}</li>)}</ul> : <p className="mt-2 text-meta text-ink-dim">No completed check was recorded.</p>}
            {evidence.acceptance_observation && <p className="mt-2 text-meta text-ink-dim">Acceptance: {evidence.acceptance_observation.outcome} · {evidence.acceptance_observation.name}</p>}
            {(evidence.unavailable_checks.length > 0 || evidence.warnings.length > 0) && <div className="mt-3 border-t border-hairline pt-2 text-meta text-thread">{evidence.unavailable_checks.map((check, index) => <p key={`${check.name}-${index}`}>Not run: {check.name}{check.detail ? ` — ${check.detail}` : ''}</p>)}{evidence.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
          </>}
          <div className="mt-3 flex flex-wrap gap-3 border-t border-hairline pt-2 text-meta">
            {onReview && <button type="button" onClick={onReview} className="text-action-bright hover:underline">Open preview</button>}
            {repository && <a href={repository.url} target="_blank" rel="noopener noreferrer" className="text-action-bright hover:underline">Open {repository.label} ↗</a>}
            {evidence && <Link to={evidence.destinations.project_history.web_path} className="text-action-bright hover:underline">Project history</Link>}
          </div>
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
  const [retryingLane, setRetryingLane] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [cleanupCandidates, setCleanupCandidates] = useState<Array<{ project_id: string; name: string; last_used_at: string }> | null>(null);
  if (message.role === 'switch') {
    const consultationId = (message.meta as { consultation?: { id?: string } } | null)?.consultation?.id;
    const status = consultationId ? data.consultations?.find((item) => item.id === consultationId) : null;
    return <>
      <BuilderHandoff threadId={data.thread.id} content={message.content} meta={message.meta} detail={data.effective_technical_detail} />
      {status && <div className={`ml-work mt-2 rounded-inset border px-3 py-2 text-meta ${status.state === 'partial' ? 'border-thread/40 bg-panel-soft text-ink' : 'border-hairline bg-panel-soft text-ink-dim'}`}>
        <span className="font-medium">{status.state === 'complete' ? 'Consultation complete' : status.state === 'partial' ? 'Consultation incomplete' : 'Consultation running'}</span>
        <span aria-hidden> · </span>{status.summary}
        {status.state === 'partial' && <span className="block mt-1 text-ink-dim">Available answers are preliminary until the failed lanes are resolved; no opinion is treated as project truth.</span>}
        <span className="mt-1 block text-ink">{status.outcome}</span>
        <details className="mt-2 text-ink-dim">
          <summary className="cursor-pointer select-none">Context receipt{status.evidence.capsule_id ? ` · ${status.evidence.capsule_id}` : ''}</summary>
          <div className="mt-1 space-y-0.5 border-l border-hairline pl-3 font-mono text-tech">
            <div>{status.receipt.known_facts} known facts · {status.receipt.observed_facts} current observations</div>
            <div>{status.evidence.repository_observed ? `${status.evidence.changed_files} changed files observed` : 'live repository unavailable'} · {status.evidence.verification_available ? 'verification included' : 'verification unavailable'}</div>
            <div>{status.receipt.generated_at ? `compiled ${new Date(status.receipt.generated_at).toLocaleString()}` : 'compilation time unavailable'}</div>
            {status.receipt.omissions.length > 0 && <div>omitted: {status.receipt.omissions.join(', ')}</div>}
          </div>
        </details>
      </div>}
    </>;
  }

  if (message.role === 'activity') {
    const record = message.meta as RunRecordView | null;
    const run = data.runs.find((r) => r.id === (record?.run_id ?? message.run_id));
    const simple = data.effective_technical_detail === 'simple';
    return (
      <div className="pl-work">
        <Reveal summary={run?.status === 'running' ? '✉ Work in progress' : '✉ Work details'}>
          <p className={simple ? 'font-body text-body text-ink-dim' : 'font-mono text-tech text-ink-dim'}>
            {simple ? simpleActivitySummary(record, run ?? null) : technicalActivitySummary(record, run ?? null)}
          </p>
          {record?.tools?.length ? (
            record.tools.map((tool) => <div key={tool.id}>{describeToolEvent(tool)}</div>)
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-tech">{message.content}</pre>
          )}
          {run && (
            <div className="mt-2 border-t border-hairline pt-2 text-ink-quiet">
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
          {run?.evidence && <EvidenceSheetPanel path={run.evidence.path} summary={run.evidence} autoOpen={typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('evidence') === run.id} />}
        </Reveal>
      </div>
    );
  }

  const messageVisuals = (data.visuals ?? []).filter((visual) => visual.message_id === message.id);
  const comparisonVisuals = message.consultation_id
    ? (data.visuals ?? []).filter((visual) => visual.consultation_id === message.consultation_id)
    : messageVisuals;
  return (
    <div id={`message-${message.id}`} className={message.role === 'owner' ? 'pl-6' : 'border-l-2 border-hairline pl-work'}>
      {/* Who actually said it. A consultation puts two answers in a row, and
          two paragraphs both labelled "Selvedge" is exactly the confusion
          asking two agents was meant to resolve. */}
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">{speakerOf(message)}</p>
      <p className="whitespace-pre-line text-body text-ink">{message.content}</p>
      {message.role === 'agent' && message.consultation_id && message.answered_by && message.consultation_lane?.status === 'failed' && (
        <div className="mt-work-tight space-y-2 text-meta">
          <div className="flex items-center gap-work-tight">
          {message.consultation_lane.recovery === 'free_sandbox_storage' && cleanupCandidates === null && (
            <button type="button" disabled={retryingLane} className="rounded-inset border border-hairline px-3 py-1.5 text-ink hover:border-action disabled:opacity-50"
              onClick={() => {
                setRetryingLane(true); setRetryNote(null);
                void api.get<{ candidates: Array<{ project_id: string; name: string; last_used_at: string }> }>(`/api/sandbox-capacity/candidates?project_id=${encodeURIComponent(data.project?.id ?? '')}`)
                  .then((result) => { setCleanupCandidates(result.candidates); if (!result.candidates.length) setRetryNote('No safe inactive workshops can be archived automatically. Workshops with unshipped or active work are protected.'); })
                  .catch((error) => setRetryNote(error instanceof Error ? error.message : 'I could not check sandbox storage.'))
                  .finally(() => setRetryingLane(false));
              }}>Find safe space to free</button>
          )}
          {message.consultation_lane.retryable !== false && (
            <button
              type="button"
              disabled={retryingLane}
              className="rounded-inset border border-hairline px-3 py-1.5 text-ink hover:border-action disabled:opacity-50"
              onClick={() => {
                setRetryingLane(true);
                setRetryNote(null);
                void api.post(`/api/threads/${encodeURIComponent(data.thread.id)}/consultations/${encodeURIComponent(message.consultation_id!)}/retry`, { agent: message.answered_by })
                  .then(() => setRetryNote(`Retrying ${agentById(message.answered_by!)?.name ?? message.answered_by} only…`))
                  .catch((error) => setRetryNote(error instanceof Error ? error.message : 'That retry did not start.'))
                  .finally(() => setRetryingLane(false));
              }}
            >
              {retryingLane ? 'Retrying…' : `Retry ${agentById(message.answered_by)?.name ?? message.answered_by} only`}
            </button>
          )}
          {retryNote && <span className="text-ink-dim">{retryNote}</span>}
          </div>
          {cleanupCandidates && cleanupCandidates.length > 0 && <div className="rounded-inset border border-hairline bg-panel-soft p-3">
            <p className="text-ink-dim">Archive one inactive workshop. Its repository and conversation remain; the sandbox is recreated next time.</p>
            <div className="mt-2 flex flex-wrap gap-2">{cleanupCandidates.map((candidate) => <button key={candidate.project_id} type="button" disabled={retryingLane}
              className="rounded-inset border border-hairline bg-panel px-3 py-1.5 text-ink hover:border-action disabled:opacity-50"
              onClick={() => {
                setRetryingLane(true); setRetryNote(null);
                void api.post('/api/sandbox-capacity/free', { project_id: candidate.project_id })
                  .then(() => api.post(`/api/threads/${encodeURIComponent(data.thread.id)}/consultations/${encodeURIComponent(message.consultation_id!)}/retry`, { agent: message.answered_by }))
                  .then(() => { setCleanupCandidates(null); setRetryNote(`Archived ${candidate.name} and retrying ${agentById(message.answered_by!)?.name ?? message.answered_by} only…`); })
                  .catch((error) => setRetryNote(error instanceof Error ? error.message : 'That cleanup and retry did not finish.'))
                  .finally(() => setRetryingLane(false));
              }}>Archive {candidate.name} and retry</button>)}</div>
          </div>}
        </div>
      )}
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
      <VisualGallery visuals={messageVisuals} comparisonVisuals={comparisonVisuals} />
    </div>
  );
}

function VisualGallery({ visuals, comparisonVisuals = visuals }: { visuals: GeneratedVisual[]; comparisonVisuals?: GeneratedVisual[] }) {
  const ready = comparisonVisuals.filter((visual) => visual.status === 'ready' && visual.content_url);
  const [selected, setSelected] = useState<GeneratedVisual | null>(null);
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [selected]);
  if (!visuals.length) return null;
  return <div className="border-l-2 border-brass pl-work">
    <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Visual interpretations</p>
    <div className={`mt-work-tight grid gap-work-tight ${ready.length > 1 ? 'sm:grid-cols-2' : ''}`}>
      {visuals.map((visual) => visual.status === 'ready' && visual.content_url ? (
        <button key={visual.id} type="button" onClick={() => setSelected(visual)} className="group overflow-hidden rounded-card border border-hairline bg-panel text-left hover:border-brass focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright">
          <img src={visual.content_url} alt={`${visual.directing_agent} visual interpretation`} className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.01]" />
          <span className="flex justify-between px-3 py-2 text-meta text-ink-dim"><span>{agentById(visual.directing_agent)?.name ?? visual.directing_agent}</span><span>Open ↗</span></span>
        </button>
      ) : (
        <div key={visual.id} className="flex aspect-square items-center justify-center rounded-card border border-hairline bg-panel-soft px-6 text-center text-body text-ink-dim">
          {visual.status === 'failed' ? (visual.error || 'This visual did not render.') : 'Rendering a visual interpretation…'}
        </div>
      ))}
    </div>
    {selected?.content_url && <div role="dialog" aria-modal="true" aria-label="Visual comparison" className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4 backdrop-blur-sm" onClick={() => setSelected(null)}>
      <div className="mb-3 flex items-center justify-between text-white"><span>{agentById(selected.directing_agent)?.name ?? selected.directing_agent}</span><button type="button" className="rounded-inset px-3 py-2 hover:bg-white/10" onClick={() => setSelected(null)}>Close</button></div>
      <div className={`grid min-h-0 flex-1 gap-4 ${ready.length > 1 ? 'md:grid-cols-2' : ''}`} onClick={(event) => event.stopPropagation()}>
        {ready.map((visual) => <figure key={visual.id} className={`min-h-0 ${visual.id === selected.id || ready.length > 1 ? '' : 'hidden'}`}>
          <img src={visual.content_url} alt={`${visual.directing_agent} visual interpretation`} className="h-full w-full rounded-card object-contain" />
          {ready.length > 1 && <figcaption className="mt-1 text-center text-meta text-white/75">{agentById(visual.directing_agent)?.name ?? visual.directing_agent}</figcaption>}
        </figure>)}
      </div>
    </div>}
  </div>;
}

const WAITING_LINES = [
  'Working on it…',
  'Thinking in complete sentences…',
  'Consulting the tiny committee…',
  'Asking the electrons nicely…',
  'Untangling the good yarn…',
  'Putting the thoughts in order…',
] as const;

function WaitingLine({ sending }: { sending: boolean }) {
  const [line, setLine] = useState<string>(sending ? 'Sending…' : WAITING_LINES[0]);
  useEffect(() => {
    if (sending) { setLine('Sending…'); return; }
    setLine(WAITING_LINES[0]);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let previous = 0;
    const timer = window.setInterval(() => {
      let next = Math.floor(Math.random() * WAITING_LINES.length);
      if (next === previous) next = (next + 1) % WAITING_LINES.length;
      previous = next;
      setLine(WAITING_LINES[next] ?? WAITING_LINES[0]);
    }, 3_800);
    return () => window.clearInterval(timer);
  }, [sending]);
  return <>{line}</>;
}

function EvidenceSheetPanel({ path, summary, autoOpen }: { path: string; summary: NonNullable<ThreadData['runs'][number]['evidence']>; autoOpen: boolean }) {
  const [open, setOpen] = useState(autoOpen);
  const [sheet, setSheet] = useState<EvidenceSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    if (sheet || busy) return;
    setBusy(true); setError(null);
    try { setSheet(await api.get<EvidenceSheet>(path)); }
    catch (e) { setError(e instanceof Error ? e.message : "I couldn't load that evidence."); }
    finally { setBusy(false); }
  }
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    await load();
  }
  useEffect(() => { if (autoOpen) void load(); }, [autoOpen]);
  return <div className="relative mt-work-tight rounded-inset border border-hairline bg-panel-soft px-3 py-2 pl-work">
    <SelvedgeEdge status={summary.status} />
    <button type="button" onClick={() => void toggle()} className="flex w-full items-start justify-between gap-3 text-left">
      <span><span className="block text-body font-medium text-ink">{summary.summary}</span><span className="block text-meta text-ink-dim">{summary.explanation}</span></span>
      <span className="shrink-0 text-meta text-action-bright">{open ? 'Hide evidence' : 'Evidence sheet'}</span>
    </button>
    {open && <div className="mt-3 border-t border-hairline pt-3 text-meta text-ink-dim">
      {busy && <p>Reading the recorded evidence…</p>}
      {error && <p className="text-thread">{error}</p>}
      {sheet && <div className="space-y-3">
        <p>{sheet.explanation}</p>
        <div><p className="font-medium text-ink">Changed files · {sheet.changed_files.total}</p>{sheet.changed_files.paths.length ? <ul className="mt-1 font-mono text-tech">{sheet.changed_files.paths.map((path) => <li key={path}>{path}</li>)}</ul> : <p>No changed-file list was recorded.</p>}</div>
        <div><p className="font-medium text-ink">Checks run · {sheet.checks_run.length}</p>{sheet.checks_run.length ? sheet.checks_run.map((check, index) => <p key={`${check.name}-${index}`}>{check.outcome} · {check.name}{check.detail ? ` — ${check.detail}` : ''}</p>) : <p>No completed check was recorded.</p>}</div>
        <div><p className="font-medium text-ink">Acceptance observation</p><p>{sheet.acceptance_observation ? `${sheet.acceptance_observation.outcome} · ${sheet.acceptance_observation.name}${sheet.acceptance_observation.detail ? ` — ${sheet.acceptance_observation.detail}` : ''}` : 'No acceptance observation was recorded.'}</p></div>
        {sheet.unavailable_checks.length > 0 && <div><p className="font-medium text-ink">Unavailable checks</p>{sheet.unavailable_checks.map((check, index) => <p key={`${check.name}-${index}`}>{check.name}{check.detail ? ` — ${check.detail}` : ''}</p>)}</div>}
        {sheet.warnings.map((warning) => <p key={warning} className="text-thread">{warning}</p>)}
        <Reveal summary="Raw evidence">
          <p>Started {sheet.timestamps.started_at ? new Date(sheet.timestamps.started_at).toLocaleString() : 'at an unknown time'} · finished {sheet.timestamps.finished_at ? new Date(sheet.timestamps.finished_at).toLocaleString() : 'not recorded'}</p>
          {sheet.raw_evidence.tools.map((tool) => <div key={tool.id}>{describeToolEvent(tool)}</div>)}
          {sheet.raw_evidence.acts.map((act, index) => <div key={`${act.at}-${index}`}>{act.at} · {act.kind} · {act.detail}</div>)}
          {!sheet.raw_evidence.tools.length && !sheet.raw_evidence.acts.length && <p>No raw steps were recorded.</p>}
        </Reveal>
        <a href={sheet.destinations.project_history.web_path} className="inline-block text-action-bright hover:underline">Open project history</a>
      </div>}
    </div>}
  </div>;
}

function TechnicalDetailControl({ data, onDone }: { data: ThreadData; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);

  async function choose(value: TechnicalDetail | null) {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/threads/${data.thread.id}/technical-detail`, { technical_detail: value });
      menu.current?.removeAttribute('open');
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That setting didn't save.");
    } finally {
      setSaving(false);
    }
  }

  const options: Array<{ value: TechnicalDetail | null; label: string; note: string }> = [
    {
      value: null,
      label: 'Use account setting',
      note: 'Return this conversation to your saved default.',
    },
    { value: 'simple', label: 'Simple', note: 'A calm conversation. Context and evidence stay one click away.' },
    { value: 'full', label: 'Full', note: 'The complete builder with project context open beside the conversation.' },
  ];

  return (
    <details ref={menu} className="relative z-20">
      <summary className="cursor-pointer list-none rounded-inset border border-hairline bg-panel px-3 py-1.5 text-meta font-medium text-ink-dim hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright [&::-webkit-details-marker]:hidden">
        View: {data.effective_technical_detail === 'full' ? 'Full' : 'Simple'} <span aria-hidden>⌄</span>
      </summary>
      <div className="absolute right-0 mt-2 w-72 overflow-hidden rounded-card border border-hairline bg-panel shadow-xl">
        <div className="border-b border-hairline px-3 py-2">
          <p className="text-body font-semibold text-ink">Workbench view</p>
          <p className="text-meta text-ink-quiet">This changes the workspace, never the project record.</p>
        </div>
        <div className="p-1.5" role="radiogroup" aria-label="Technical detail for this conversation">
          {options.map((option) => {
            const selected = data.technical_detail === option.value;
            return (
              <button
                key={option.value ?? 'account'}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving}
                onClick={() => void choose(option.value)}
                className={`flex w-full items-start gap-2 rounded-inset px-2.5 py-2 text-left hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-60 ${selected ? 'bg-panel-soft' : ''}`}
              >
                <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-action-bright' : 'border border-ink-faint'}`} />
                <span>
                  <span className="block text-body font-medium text-ink">{option.label}</span>
                  <span className="block text-meta text-ink-quiet">{option.note}</span>
                </span>
              </button>
            );
          })}
        </div>
        {error && <p role="alert" className="border-t border-hairline px-3 py-2 text-meta text-thread">{error}</p>}
      </div>
    </details>
  );
}

export function ThreadPane({
  data,
  liveReplies,
  onReload,
  onOpenThread,
  switcherOpen,
  onSwitcherOpenChange,
  composerRef,
  onShowPreview,
}: {
  data: ThreadData;
  liveReplies: LiveReply[];
  onReload: () => void;
  onOpenThread: (threadId: string) => void;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  onShowPreview: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Plain model chat has no sandbox run, so `data.working` remains false while
  // the provider answers. Keep the accepted turn live until its reply lands.
  const [awaitingReply, setAwaitingReply] = useState(false);
  const expectedAgentCount = useRef<number | null>(null);
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
  const [shipRequested, setShipRequested] = useState<{ branch: string } | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  // Narrows the join-or-create list — on a real account it is twenty-eight
  // projects long, and scrolling a list is slower than typing three letters.
  const [projectFilter, setProjectFilter] = useState('');
  const [moving, setMoving] = useState(false);
  const orderedLiveReplies = useMemo(() => {
    const order = new Map<string, number>();
    for (const message of data.messages) {
      const consultation = (message.meta as { consultation?: { id?: string; agents?: string[] } } | null)?.consultation;
      if (!consultation?.id || !Array.isArray(consultation.agents)) continue;
      consultation.agents.forEach((agent, index) => order.set(`${consultation.id}:${agent}`, index));
    }
    return [...liveReplies].sort((a, b) => {
      if (a.consultationId && a.consultationId === b.consultationId) {
        return (order.get(`${a.consultationId}:${a.agent}`) ?? 999) - (order.get(`${b.consultationId}:${b.agent}`) ?? 999);
      }
      return 0;
    });
  }, [data.messages, liveReplies]);
  const end = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const workshop = data.thread.kind === 'workshop';
  const currentOffer = roster.find((offer) => offer.id === data.thread.agent) ?? null;

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
    // The just-sent owner row already occupied this exact place optimistically.
    // Replacing it with the server row is reconciliation, not new navigation.
    if (newest?.role === 'owner') return;
    const node = newest ? document.getElementById(`message-${newest.id}`) : null;
    (node ?? end.current)?.scrollIntoView({ behavior: 'smooth', block: node ? 'start' : 'end' });
  }, [data.messages.length, data.messages]);

  // Move only far enough to keep the sent line and the stable response row in
  // view. Later acknowledgement changes their state in place and does not
  // retarget the scroll position.
  useEffect(() => {
    if (!optimistic) return;
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [optimistic]);

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

  useEffect(() => {
    if (!awaitingReply || expectedAgentCount.current === null) return;
    const answers = data.messages.filter((message) => message.role === 'agent').length;
    if (answers >= expectedAgentCount.current) {
      setAwaitingReply(false);
      expectedAgentCount.current = null;
    }
  }, [awaitingReply, data.messages]);

  // Fast reconciliation for accepted chat turns. A live event stream can
  // replace this fallback later; today it removes the twelve-second quiet gap.
  useEffect(() => {
    if (!awaitingReply || data.working) return;
    const interval = window.setInterval(onReload, 1500);
    return () => window.clearInterval(interval);
  }, [awaitingReply, data.working, onReload]);

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
    expectedAgentCount.current = data.messages.filter((message) => message.role === 'agent').length + 1;
    setAwaitingReply(true);
    try {
      const res = await api.post<{ started: boolean; warming: boolean; consulted?: string[] }>(`/api/threads/${data.thread.id}/message`, {
        text: body,
        ...(images.length ? { images: images.map((i) => ({ mime: i.mime, dataBase64: i.dataBase64 })) } : {}),
        ...(files.length ? { files: files.map((f) => ({ id: f.id })) } : {}),
        ...(documents.length ? { documents } : {}),
        ...(acknowledgeStale ? { acknowledge_stale: true } : {}),
        ...(raiseCap ? { raise_cap: true } : {}),
      });
      if (res.consulted?.length) {
        expectedAgentCount.current = data.messages.filter((message) => message.role === 'agent').length + res.consulted.length;
      }
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
      setAwaitingReply(false);
      expectedAgentCount.current = null;
      // Both of these are refusals with a way through, not dead ends: keep what
      // was typed, say what is in the way, and let the owner choose. The
      // message is NOT sent by the act of being told.
      const body409 = err instanceof ApiError && err.status === 409 ? err.body : null;
      const stale = body409 ? staleRefusalOf(body409) : null;
      const hit = body409 ? ceilingRefusalOf(body409) : null;
      const nowhere = body409 ? needsProjectOf(body409) : null;
      const shipConfirmation = body409?.ship_confirmation as Record<string, unknown> | undefined;
      const wantsShip = body409?.code === 'confirm_ship' && typeof shipConfirmation?.branch === 'string';
      const message = err instanceof Error ? err.message : '';
      if (wantsShip) {
        setText('');
        setShipRequested({ branch: shipConfirmation!.branch as string });
      } else if (stale) setStaleRefusal({ refusal: stale, message });
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

  async function chooseModel(model: string) {
    setNote(null);
    try {
      await api.patch(`/api/threads/${data.thread.id}`, { model });
      onReload();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that model didn't switch");
    }
  }

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-work border-b border-hairline bg-panel-soft/40 px-work-loose py-work">
        <div className="min-w-0 flex-1">
          <p className="section-label mb-2">
            {data.project ? <Link to={`/projects/${data.project.id}`} className="hover:text-action-bright">{data.project.name}</Link> : data.subject?.name ?? 'Unfiled'} <span aria-hidden>／</span> {workshop ? 'Workshop' : 'Conversation'}
          </p>
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
              className="w-full rounded-inset border border-hairline bg-panel px-2 py-1 text-2xl font-semibold leading-tight text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            />
          ) : (
            <button onClick={() => setRenaming(true)} title="Rename this work" className="line-clamp-2 block max-w-3xl text-left text-[clamp(1.25rem,2.2vw,1.65rem)] font-semibold leading-[1.18] tracking-[-0.015em] text-ink hover:text-ink-dim">
              {data.thread.title}
            </button>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-quiet">
            <AgentChip agent={data.thread.agent} working={data.working} />
            {data.project && <><span aria-hidden>·</span><ReceivedContext projectId={data.project.id} showReceipt={data.effective_technical_detail === 'full'} /></>}
            {data.effective_technical_detail === 'full' && <><span aria-hidden>·</span><span>{formatCents(data.cost_cents)}</span></>}
            {workshop && data.effective_technical_detail === 'full' && <><span aria-hidden>·</span><span>{data.sandbox === 'attached' ? 'workshop warm' : 'workshop cold'}</span></>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <TechnicalDetailControl data={data} onDone={onReload} />
          {workshop && data.project && (
            <button
              type="button"
              onClick={onShowPreview}
              className="rounded-inset bg-action px-4 py-2 text-body font-semibold text-ink shadow-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
            >
              Preview changes →
            </button>
          )}
        </div>
      </header>

      {data.project && <MigrationJourneyPanel projectId={data.project.id} working={data.working} />}

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
        {groupPairedConsultations(data.messages).map((item) => item.kind === 'message' ? (
          <Message key={item.message.id} message={item.message} data={data} />
        ) : (
          <OpinionComparison
            key={`comparison-${item.prompt.id}`}
            promptId={item.prompt.id}
            answers={[
              { agent: item.agents[0], body: <Message message={item.answers[0]} data={data} /> },
              { agent: item.agents[1], body: <Message message={item.answers[1]} data={data} /> },
            ]}
          />
        ))}
        {optimistic && (
          <div className="opacity-70 transition-opacity duration-200">
            <Message message={optimistic} data={data} />
          </div>
        )}
        {(sending || optimistic || awaitingReply || warming || data.working || orderedLiveReplies.length > 0) && (
          <div className="flex min-h-12 items-start gap-work border-l-2 border-brass pl-work transition-colors duration-200">
            <div className="flex-1">
              <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge</p>
              {orderedLiveReplies.length >= 2 ? (
                <OpinionComparison
                  promptId={orderedLiveReplies[0]?.consultationId ?? orderedLiveReplies[0]?.turnId ?? 'live'}
                  answers={orderedLiveReplies.map((reply) => ({
                    agent: reply.agent,
                    body: <p className="min-h-6 whitespace-pre-wrap text-body text-ink-dim">{reply.text || (reply.capability === 'build' ? 'Building — details are arriving in the work envelope…' : <WaitingLine sending={false} />)}</p>,
                  }))}
                />
              ) : (
                <p className="min-h-6 whitespace-pre-wrap text-body text-ink-dim">{orderedLiveReplies[0]?.text || (orderedLiveReplies[0]?.capability === 'build' ? 'Building — details are arriving in the work envelope…' : <WaitingLine sending={sending} />)}</p>
              )}
            </div>
            {/* The way out. A turn you can start and not stop is a turn that
                owns you rather than the other way round — and while it runs,
                the project takes no other work. */}
            {(data.working || orderedLiveReplies.some((reply) => reply.capability === 'visual')) && (
              <button
                type="button"
                disabled={stopping}
                onClick={() => void stop()}
                className="text-meta text-ink-quiet hover:text-thread disabled:opacity-50"
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
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
        <ShipControls
          data={{ ...data, project: data.project }}
          prompted={Boolean(shipRequested)}
          branch={shipRequested?.branch}
          onReview={onShowPreview}
          onCancel={shipRequested ? () => setShipRequested(null) : undefined}
          onDone={() => { setShipRequested(null); onReload(); }}
        />
      )}

      <div className="workbench-composer border-t border-hairline px-work-loose py-work">
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
            title="Choose an agent (Cmd+J)"
            className="flex items-center gap-2 rounded-inset border border-hairline bg-panel px-2.5 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            <AgentChip agent={data.thread.agent} />
            <span className="hidden text-meta text-ink-dim sm:inline">Agent</span>
            <span aria-hidden className="text-meta text-ink-quiet">⌄</span>
          </button>
          {currentOffer && currentOffer.models.length > 1 && (
            <label className="sr-only" htmlFor={`model-${data.thread.id}`}>Model version</label>
          )}
          {currentOffer && currentOffer.models.length > 1 && (
            <select
              id={`model-${data.thread.id}`}
              value={data.thread.model ?? currentOffer.selected_model}
              onChange={(event) => void chooseModel(event.target.value)}
              disabled={sending}
              title="Choose model version"
              className="max-w-32 rounded-inset border border-hairline bg-panel-soft px-2 py-2 font-mono text-tech text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
            >
              {currentOffer.models.map((option) => (
                <option key={option.id} value={option.id}>{option.label} · {option.note}</option>
              ))}
            </select>
          )}
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
