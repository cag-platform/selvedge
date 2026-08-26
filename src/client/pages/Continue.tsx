import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ContextHealth, ProjectBrief, ProjectBriefClaim } from '../../shared/types/continuation.js';
import type { CheckoutGuard, CheckoutResolution } from '../../shared/types/checkoutGuard.js';
import { ApiError, api, apiUpload } from '../lib/api.js';
import { btnPrimary, inputCls, Pane } from '../components/ui.js';

type Project = { project_id: string; name: string; links?: { repo?: string } };
type ImportResult = { filed: number; already_had: number; thread_ids: string[]; summary: string; unreadable_count: number };

export function Continue() {
  const navigate = useNavigate();
  const { continuationId: linkedContinuationId, claimId } = useParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [continuationId, setContinuationId] = useState('');
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<'conversation' | 'note' | 'document' | 'url'>('conversation');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [health, setHealth] = useState<ContextHealth | null>(null);
  const [workThreadId, setWorkThreadId] = useState('');
  const [guard, setGuard] = useState<CheckoutGuard | null>(null);

  useEffect(() => {
    api.get<Project[]>('/api/projects').then((rows) => {
      setProjects(rows);
      if (rows[0]) setProjectId(rows[0].project_id);
    }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!linkedContinuationId) return;
    api.get<ProjectBrief>(`/api/continuations/${encodeURIComponent(linkedContinuationId)}/brief`).then((loaded) => {
      setContinuationId(linkedContinuationId); setProjectId(loaded.project.id); setBrief(loaded);
      window.setTimeout(() => document.getElementById(`claim-${claimId ?? ''}`)?.scrollIntoView({ block: 'center' }), 0);
    }).catch((e: Error) => setError(e.message));
  }, [linkedContinuationId, claimId]);

  async function begin() {
    if (!projectId) return;
    setBusy(true); setError(null);
    try {
      const out = await api.post<{ continuation: { id: string } }>('/api/continuations', { project_id: projectId });
      setContinuationId(out.continuation.id);
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through."); }
    finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (!continuationId) return;
    setBusy(true); setError(null); setImportNote(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // Keep the imported history in its vendor home. The reviewed conversation
      // is linked to the project by the continuation, without misfiling an
      // entire account export under one codebase.
      const imported = await apiUpload<ImportResult>('/api/import/history', form);
      if (!imported.thread_ids.length) throw new Error('Those conversations were already imported. Choose a fresh export for this first walkthrough.');
      for (const threadId of imported.thread_ids) {
        await api.post(`/api/continuations/${continuationId}/sources/imported-threads`, { thread_id: threadId });
      }
      setImportNote(`${imported.summary} ${imported.thread_ids.length} conversation${imported.thread_ids.length === 1 ? '' : 's'} will travel with this project.`);
      const next = await api.post<ProjectBrief>(`/api/continuations/${continuationId}/analyze`, {});
      setBrief(next);
      setHealth(await api.get<ContextHealth>(`/api/projects/${encodeURIComponent(projectId)}/context-health`));
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through."); }
    finally { setBusy(false); }
  }

  async function addSource() {
    if (!continuationId) return;
    setBusy(true); setError(null);
    try {
      const endpoint = sourceMode === 'note' ? 'notes' : sourceMode === 'document' ? 'documents' : 'urls';
      const body = sourceMode === 'url' ? { url: sourceUrl, title: sourceTitle || undefined, excerpt: sourceText || undefined }
        : { title: sourceTitle || (sourceMode === 'note' ? 'Pasted note' : undefined), text: sourceText, ...(sourceMode === 'document' ? { mime_type: 'text/plain' } : {}) };
      await api.post(`/api/continuations/${continuationId}/sources/${endpoint}`, body);
      const next = await api.post<ProjectBrief>(`/api/continuations/${continuationId}/analyze`, {});
      setBrief(next);
      setHealth(await api.get<ContextHealth>(`/api/projects/${encodeURIComponent(projectId)}/context-health`));
      setImportNote(`${sourceTitle || (sourceMode === 'url' ? sourceUrl : 'Source')} will travel with this project.`);
      setSourceTitle(''); setSourceText(''); setSourceUrl('');
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through."); }
    finally { setBusy(false); }
  }

  async function reviewWork() {
    if (!brief || !intent.trim()) return;
    setBusy(true); setError(null);
    try {
      const accepted = await api.post<{ thread: { id: string } }>(`/api/continuations/${brief.continuation_id}/accept`, {});
      const next = await api.post<CheckoutGuard>(`/api/projects/${encodeURIComponent(brief.project.id)}/checkout/preflight`, { thread_id: accepted.thread.id, goal: intent.trim() });
      setWorkThreadId(accepted.thread.id);
      setGuard(next);
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through."); setBusy(false); }
    finally { setBusy(false); }
  }

  async function startWork(resolution?: CheckoutResolution) {
    if (!workThreadId) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/threads/${workThreadId}/message`, { text: intent.trim(), ...(resolution ? { checkout_resolution: resolution } : {}) });
      navigate(`/inbox/${workThreadId}`);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'checkout_conflict' && e.body.checkout_guard) setGuard(e.body.checkout_guard as CheckoutGuard);
      setError(e instanceof Error ? e.message : "That didn't go through.");
      setBusy(false);
    }
  }

  const chosen = projects.find((project) => project.project_id === projectId);
  return <div className="animate-settle mx-auto max-w-4xl px-5 pb-20 pt-14 sm:px-8 sm:pt-20">
    <header className="max-w-2xl">
      <p className="font-mono text-label font-semibold uppercase tracking-[0.16em] text-action">Continue a project</p>
      <h1 className="mt-4 font-display text-[clamp(2.5rem,6vw,4rem)] font-normal leading-none tracking-[-0.045em] text-ink">Pick up where you left off.</h1>
      <p className="mt-4 text-lede text-ink-dim">Bring the project and one useful AI conversation. Another agent can continue without you explaining it all again.</p>
    </header>

    <ol className="mt-10 grid gap-5">
      <li><Pane className="p-5 sm:p-6">
        <Step number="1" title="Which project are you continuing?" detail="The work stays with this project — not with whichever agent answers next." />
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-body text-ink-dim">Existing project
            <select className={inputCls} value={projectId} disabled={Boolean(continuationId)} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
            </select>
          </label>
          {!continuationId && <button className={btnPrimary} disabled={!projectId || busy} onClick={() => void begin()}>{busy ? 'Opening…' : 'Use this project'}</button>}
          {continuationId && <span className="pb-1 text-body font-medium text-healthy">✓ {chosen?.name} attached</span>}
        </div>
        {!projects.length && !error && <p className="mt-4 text-body text-ink-dim">Add an existing repository as a project first, then come back here.</p>}
      </Pane></li>

      <li className={!continuationId ? 'opacity-45' : ''}><Pane className="p-5 sm:p-6">
        <Step number="2" title="Add the context that matters" detail="Bring a conversation, note, document, or URL. Selvedge keeps its source, date, and limitations so history is not mistaken for current code." />
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Source type">
          {(['conversation', 'note', 'document', 'url'] as const).map((mode) => <button type="button" key={mode} disabled={!continuationId || busy} onClick={() => setSourceMode(mode)} className={`rounded-full border px-3 py-1.5 text-meta capitalize ${sourceMode === mode ? 'border-action bg-sage text-ink' : 'border-hairline text-ink-dim'}`}>{mode}</button>)}
        </div>
        {sourceMode === 'conversation' ? <label className={`mt-4 inline-flex cursor-pointer items-center ${btnPrimary} ${!continuationId || busy ? 'pointer-events-none opacity-50' : ''}`}>
          {busy && continuationId ? 'Reading…' : 'Choose ChatGPT or Claude export'}
          <input className="sr-only" type="file" accept=".zip,.json,application/json,application/zip" disabled={!continuationId || busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
        </label> : <div className="mt-4 grid gap-3">
          <input className={inputCls} value={sourceTitle} disabled={!continuationId || busy} onChange={(e) => setSourceTitle(e.target.value)} placeholder={sourceMode === 'url' ? 'Page title (optional)' : 'Source title'} />
          {sourceMode === 'url' && <input className={inputCls} type="url" value={sourceUrl} disabled={!continuationId || busy} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://example.com/current-spec" />}
          <textarea className={`${inputCls} min-h-24 resize-y`} value={sourceText} disabled={!continuationId || busy} onChange={(e) => setSourceText(e.target.value)} placeholder={sourceMode === 'url' ? 'Paste the relevant excerpt (optional)' : sourceMode === 'document' ? 'Paste extracted document text' : 'Paste the note'} />
          <button type="button" className={`${btnPrimary} justify-self-start`} disabled={!continuationId || busy || (sourceMode === 'url' ? !sourceUrl.trim() : !sourceText.trim()) || (sourceMode === 'document' && !sourceTitle.trim())} onClick={() => void addSource()}>{busy ? 'Adding…' : 'Add source'}</button>
        </div>}
        {importNote && <p className="mt-3 text-body text-ink-dim">{importNote}</p>}
      </Pane></li>

      <li className={!brief ? 'opacity-45' : ''}><Pane className="p-5 sm:p-6">
        <Step number="3" title="Review what Selvedge understood" detail="Claims are grouped by certainty. Sources and freshness stay visible; missing facts remain missing." />
        {brief && <div className="mt-5 grid gap-5 md:grid-cols-3">
          <ClaimGroup title="Understood" claims={brief.understood} empty="Nothing confirmed yet." />
          <ClaimGroup title="Needs confirmation" claims={brief.needs_confirmation} empty="No consequential questions." />
          <ClaimGroup title="Still missing" claims={brief.still_missing} empty="Nothing material is missing." />
        </div>}
        {health && <p className="mt-5 border-t border-hairline pt-4 text-body text-ink-dim"><strong className="text-ink">Context health · {health.status.replace('_', ' ')}</strong> — {health.summary}</p>}
      </Pane></li>

      <li className={!brief?.can_continue ? 'opacity-45' : ''}><Pane className="p-5 sm:p-6">
        <Step number="4" title="What are you trying to do next?" detail={`This starts a normal ${brief?.project.name ?? 'project'} thread with the reviewed conversation attached. You can change agents without moving the work.`} />
        <textarea className={`${inputCls} mt-4 min-h-28 resize-y`} value={intent} disabled={!brief?.can_continue || busy || Boolean(guard)} onChange={(e) => setIntent(e.target.value)} placeholder="For example: fix the mobile sign-in error and verify it without changing production" />
        {!guard && <button className={`${btnPrimary} mt-3`} disabled={!brief?.can_continue || !intent.trim() || busy} onClick={() => void reviewWork()}>{busy && brief ? 'Checking…' : 'Review the change plan'}</button>}
        {guard && <CheckoutReview guard={guard} busy={busy} onStart={(resolution) => void startWork(resolution)} onReview={() => navigate(guard.ownership?.thread_id ? `/inbox/${guard.ownership.thread_id}` : `/projects/${guard.project_id}/workshop`)} />}
      </Pane></li>
    </ol>
    {error && <p role="alert" className="mt-4 border-l-2 border-thread pl-3 text-body text-thread">{error}</p>}
  </div>;
}

function CheckoutReview({ guard, busy, onStart, onReview }: { guard: CheckoutGuard; busy: boolean; onStart: (resolution?: CheckoutResolution) => void; onReview: () => void }) {
  const plan = guard.plan;
  const continueChoice = guard.choices.find((choice) => choice.id === 'continue_existing');
  return <section className="mt-5 rounded-inset border border-hairline bg-paper-soft p-4" aria-label="Bounded change plan">
    <p className="section-label">Checkout guard · {guard.state.replaceAll('_', ' ')}</p>
    <h3 className="mt-2 font-display text-xl text-ink">{plan.goal}</h3>
    <dl className="mt-4 grid gap-3 text-body text-ink-dim sm:grid-cols-2">
      <div><dt className="font-medium text-ink">Expected area</dt><dd>{plan.expected_area}</dd></div>
      <div><dt className="font-medium text-ink">Time boundary</dt><dd>{plan.expected_duration_minutes.minimum}–{plan.expected_duration_minutes.maximum} minutes; automatic stop after {plan.automatic_stop.after_minutes}.</dd></div>
      <div><dt className="font-medium text-ink">Risk boundary</dt><dd>{plan.risk_boundary}</dd></div>
      <div><dt className="font-medium text-ink">Verification</dt><dd>{plan.verification.join(' ')}</dd></div>
    </dl>
    {guard.existing_work && <p className="mt-4 text-body text-thread">Existing work is present{guard.existing_work.changed_paths.length ? ` in ${guard.existing_work.changed_paths.join(', ')}` : ''}. It will not be overwritten.</p>}
    <p className="mt-3 text-meta text-ink-quiet">Preview: {guard.preview.state === 'available' ? 'already available' : 'not started'}. Reviewing this plan did not start or wake it.</p>
    {guard.safe_to_start ? <button className={`${btnPrimary} mt-4`} disabled={busy} onClick={() => onStart()}>{busy ? 'Starting…' : 'Start bounded change'}</button>
      : <div className="mt-4 flex flex-wrap gap-2">
        {continueChoice?.available && <button className={btnPrimary} disabled={busy} onClick={() => onStart('continue_existing')}>Continue attributable work</button>}
        {guard.choices.filter((choice) => choice.available && choice.id === 'review_existing').map((choice) => <button type="button" key={choice.id} className="rounded-full border border-hairline px-3 py-2 text-meta text-ink-dim" onClick={onReview}>{choice.label}</button>)}
        {guard.choices.filter((choice) => choice.available && choice.id === 'wait').map((choice) => <span key={choice.id} className="rounded-full border border-hairline px-3 py-2 text-meta text-ink-dim">{choice.label}: {choice.effect}</span>)}
      </div>}
    {!guard.fresh_isolated_checkout.supported && <p className="mt-3 text-meta text-ink-quiet">Fresh isolated checkout unavailable: {guard.fresh_isolated_checkout.reason}</p>}
  </section>;
}

function Step({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="flex gap-4"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sage font-mono text-meta text-action">{number}</span><div><h2 className="font-display text-2xl font-normal text-ink">{title}</h2><p className="mt-1 text-body leading-relaxed text-ink-dim">{detail}</p></div></div>;
}

function ClaimGroup({ title, claims, empty }: { title: string; claims: ProjectBriefClaim[]; empty: string }) {
  return <section><p className="section-label">{title} · {claims.length}</p><div className="mt-2 space-y-2">{claims.length ? claims.map((claim) => <article id={`claim-${claim.id}`} key={claim.id} className="scroll-mt-24 rounded-inset border border-hairline bg-paper-soft p-3 target:border-action"><p className="text-body text-ink">{claim.text}</p><p className="mt-2 font-mono text-tech text-ink-quiet">{claim.confidence} · {claim.evidence.length ? claim.evidence.map((item) => `${item.label} · seen ${new Date(item.observed_at).toLocaleDateString()}`).join('; ') : 'no source yet'}</p></article>) : <p className="text-meta text-ink-quiet">{empty}</p>}</div></section>;
}
