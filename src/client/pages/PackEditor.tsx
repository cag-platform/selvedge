import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { ContextPack, StakesTier, UserScale, DetailLevel, PushThreshold } from '../../shared/types/pack.js';
import { Pane, btnDanger, btnGhost, btnPrimary, inputCls, labelCls } from '../components/ui.js';
import { SelvedgeEdge } from '../components/SelvedgeEdge.js';
import { entryEdge, outcomeLabel, formatCents, type LedgerEntryData } from '../lib/ledger.js';

/**
 * The pack editor ("The Look", Prompt 5): identity in the owner's own
 * words, the three stakes questions phrased exactly as in the schema doc,
 * and the voice controls. Plain language throughout — this is where the
 * owner teaches Selvedge what a project *means*, not a config form.
 */
export function PackEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [muting, setMuting] = useState(false);

  useEffect(() => {
    if (projectId) api.get<ContextPack>(`/api/packs/${projectId}`).then(setPack);
  }, [projectId]);

  // The muted flag lives on the project row (not in the pack JSON), so read it
  // from the projects listing.
  useEffect(() => {
    api
      .get<Array<{ project_id: string; muted?: boolean }>>('/api/projects')
      .then((list) => setMuted(list.find((p) => p.project_id === projectId)?.muted ?? false))
      .catch(() => {});
  }, [projectId]);

  if (!pack) return <p className="text-body text-ink-quiet">Loading…</p>;

  async function save() {
    if (!pack) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/packs/${projectId}`, { identity: pack.identity, stakes: pack.stakes, voice: pack.voice });
      navigate('/projects');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    setDeleting(true);
    setError(null);
    try {
      await api.del(`/api/packs/${projectId}`);
      navigate('/projects');
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
    }
  }

  async function toggleMute() {
    setMuting(true);
    setError(null);
    try {
      const next = !muted;
      await api.patch(`/api/packs/${projectId}/mute`, { muted: next });
      setMuted(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMuting(false);
    }
  }

  return (
    <Pane className="animate-settle space-y-7 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-headline font-display text-ink">Teach me about {pack.identity.name}</h1>
        <button
          className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          onClick={() => navigate(`/projects/${projectId}/workshop`)}
        >
          Open the workshop
        </button>
      </div>

      <section className="space-y-3">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Identity</h2>
        <label className={labelCls}>
          Name
          <input
            className={inputCls}
            value={pack.identity.name}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, name: e.target.value } })}
          />
        </label>
        <label className={labelCls}>
          Describe it in your own words
          <textarea
            className={inputCls}
            rows={3}
            value={pack.identity.owner_description}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, owner_description: e.target.value } })}
          />
        </label>
        <label className={labelCls}>
          Who uses it?
          <input
            className={inputCls}
            value={pack.identity.audience ?? ''}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, audience: e.target.value } })}
          />
        </label>
      </section>

      {/* The three stakes questions, phrased exactly as in the schema doc. */}
      <section className="space-y-3">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Stakes</h2>

        <label className={labelCls}>
          Does anyone besides you use this?
          <select
            className={inputCls}
            value={pack.stakes.has_external_users ? 'yes' : 'no'}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, has_external_users: e.target.value === 'yes' } })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label className={labelCls}>
          Roughly how many?
          <select
            className={inputCls}
            value={pack.stakes.user_scale ?? 'none'}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, user_scale: e.target.value as UserScale } })}
          >
            <option value="none">None</option>
            <option value="handful">A handful</option>
            <option value="dozens">Dozens</option>
            <option value="hundreds">Hundreds</option>
            <option value="thousands_plus">Thousands+</option>
          </select>
        </label>

        <label className={labelCls}>
          Does it touch money?
          <select
            className={inputCls}
            value={pack.stakes.touches_money ? 'yes' : 'no'}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, touches_money: e.target.value === 'yes' } })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label className={labelCls}>
          Stakes tier
          <select
            className={inputCls}
            value={pack.stakes.tier}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, tier: e.target.value as StakesTier } })}
          >
            <option value="sandbox">Sandbox — an experiment</option>
            <option value="personal">Personal — just for me</option>
            <option value="live_small">Live — real people use it</option>
            <option value="live_critical">Live · critical — people depend on it</option>
          </select>
        </label>

        <label className={labelCls}>
          If this goes down, what happens?
          <textarea
            className={inputCls}
            rows={2}
            value={pack.stakes.downtime_translation ?? ''}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, downtime_translation: e.target.value } })}
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Voice</h2>
        <label className={labelCls}>
          How much detail do you want?
          <select
            className={inputCls}
            value={pack.voice.detail_level}
            onChange={(e) => setPack({ ...pack, voice: { ...pack.voice, detail_level: e.target.value as DetailLevel } })}
          >
            <option value="plain_only">Just tell me what's happening</option>
            <option value="plain_expandable">Explain it, let me see details</option>
            <option value="technical_forward">I know my way around</option>
          </select>
        </label>
        <label className={labelCls}>
          When should I push a notification?
          <select
            className={inputCls}
            value={pack.voice.notify?.push_threshold ?? 'failures'}
            onChange={(e) =>
              setPack({ ...pack, voice: { ...pack.voice, notify: { ...pack.voice.notify, push_threshold: e.target.value as PushThreshold } } })
            }
          >
            <option value="never">Never</option>
            <option value="critical_only">Critical only</option>
            <option value="failures">Failures</option>
            <option value="everything">Everything</option>
          </select>
        </label>
      </section>

      {error && <p className="text-body text-thread">{error}</p>}

      <div className="flex gap-2">
        <button className={btnPrimary} disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className={btnGhost} onClick={() => navigate('/projects')}>
          Cancel
        </button>
      </div>

      <section className="space-y-3 border-t border-hairline pt-6">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Priority</h2>
        <p className="text-body text-ink-dim">
          {muted
            ? 'Muted — kept out of your daily brief and collapsed on the projects page.'
            : 'Showing in your daily brief.'}
        </p>
        <button
          className="text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          disabled={muting}
          onClick={toggleMute}
        >
          {muting ? 'Updating…' : muted ? 'Unmute' : 'Mute this project'}
        </button>
      </section>

      {projectId && <ProjectRecord projectId={projectId} />}

      {projectId && <BeaconSection projectId={projectId} />}

      <section className="space-y-3 border-t border-hairline pt-6">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Delete</h2>
        {!confirmingDelete ? (
          <button className="text-body text-thread hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright" onClick={() => setConfirmingDelete(true)}>
            Delete this project
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-body text-ink">
              Delete {pack.identity.name} for good? This removes the project and everything I've tracked for it. There's no undo.
            </p>
            <div className="flex gap-2">
              <button className={btnDanger} disabled={deleting} onClick={del}>
                {deleting ? 'Deleting…' : 'Yes, delete it'}
              </button>
              <button className={btnGhost} onClick={() => setConfirmingDelete(false)}>
                Keep it
              </button>
            </div>
          </div>
        )}
      </section>
    </Pane>
  );
}

/**
 * This project's track record — its slice of the ledger. What Selvedge has done
 * here, what it cost, how it turned out. Misses shown as misses.
 */
function ProjectRecord({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<LedgerEntryData[] | null>(null);

  useEffect(() => {
    api
      .get<{ entries: LedgerEntryData[] }>(`/api/ledger?project=${encodeURIComponent(projectId)}`)
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
  }, [projectId]);

  if (!entries || entries.length === 0) return null;
  const spent = entries.reduce((sum, e) => sum + e.spentCents, 0);

  return (
    <section className="space-y-3 border-t border-hairline pt-6">
      <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Track record</h2>
      <p className="text-meta text-ink-quiet">
        {entries.length} change{entries.length === 1 ? '' : 's'} · {formatCents(spent)} all-in
      </p>
      <div className="space-y-2">
        {entries.slice(0, 8).map((e) => (
          <div key={e.cardId} className="relative rounded-inset border border-hairline bg-panel-soft px-3 py-2 pl-4">
            <SelvedgeEdge status={entryEdge(e)} />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-body text-ink">{e.intent}</p>
              <span className="shrink-0 text-meta text-ink-quiet">{outcomeLabel(e)} · {formatCents(e.spentCents)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Error reporting (the beacon). An optional, advanced connection: point your
 * app's error counts at Selvedge and it watches for a spike above the app's own
 * baseline. The token is shown exactly once, on setup — Selvedge stores only a
 * hash of it, so it can never be shown again.
 */
function BeaconSection({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<{ issued: boolean; lastSeenAt: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<{ issued: boolean; lastSeenAt: string | null }>(`/api/projects/${projectId}/beacon`)
      .then(setStatus)
      .catch(() => setStatus({ issued: false, lastSeenAt: null }));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function issue() {
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>(`/api/projects/${projectId}/beacon`, {});
      setToken(r.token);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await api.del(`/api/projects/${projectId}/beacon`);
      setToken(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 border-t border-hairline pt-6">
      <h2 className="text-label font-body uppercase tracking-widest text-ink-quiet">Error reporting</h2>
      <p className="text-body text-ink-dim">
        Optional. If your app can report how many requests errored, I'll watch for a spike above its normal rate and
        raise it — the same as anything else that breaks. Most apps don't need this.
      </p>

      {token && (
        <div className="space-y-1 rounded-inset border border-hairline bg-panel-soft px-3 py-2">
          <p className="text-meta text-ink-dim">Your beacon token — copy it now, it won't be shown again:</p>
          <code className="block break-all font-mono text-tech text-ink">{token}</code>
          <p className="text-meta text-ink-quiet">
            Have your app POST {`{ errors, requests }`} per window to <span className="font-mono">/beacons/errors</span> with
            header <span className="font-mono">X-Beacon-Token</span>.
          </p>
        </div>
      )}

      {status?.issued ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-meta text-ink-quiet">
            Reporting is on{status.lastSeenAt ? ` — last report ${new Date(status.lastSeenAt).toLocaleString()}` : ' — no reports yet'}.
          </span>
          <button className="text-body text-action-bright hover:underline" disabled={busy} onClick={issue}>
            Regenerate token
          </button>
          <button className="text-body text-thread hover:underline" disabled={busy} onClick={revoke}>
            Turn off
          </button>
        </div>
      ) : (
        <button className="text-body text-action-bright hover:underline" disabled={busy} onClick={issue}>
          {busy ? 'Setting up…' : 'Set up error reporting'}
        </button>
      )}
    </section>
  );
}
