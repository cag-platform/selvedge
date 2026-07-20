import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { ContextPack, StakesTier, UserScale, DetailLevel, PushThreshold } from '../../shared/types/pack.js';
import { Pane, btnDanger, btnGhost, btnPrimary, inputCls, labelCls } from '../components/ui.js';

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

  useEffect(() => {
    if (projectId) api.get<ContextPack>(`/api/packs/${projectId}`).then(setPack);
  }, [projectId]);

  if (!pack) return <p className="text-body text-ink-faint">Loading…</p>;

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

  return (
    <Pane className="animate-settle space-y-7 p-6">
      <h1 className="text-headline font-display text-ink">Teach me about {pack.identity.name}</h1>

      <section className="space-y-3">
        <h2 className="text-label font-body uppercase tracking-widest text-ink-faint">Identity</h2>
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
        <h2 className="text-label font-body uppercase tracking-widest text-ink-faint">Stakes</h2>

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
        <h2 className="text-label font-body uppercase tracking-widest text-ink-faint">Voice</h2>
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
        <h2 className="text-label font-body uppercase tracking-widest text-ink-faint">Delete</h2>
        {!confirmingDelete ? (
          <button className="text-body text-thread hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass" onClick={() => setConfirmingDelete(true)}>
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
