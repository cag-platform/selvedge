import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { ContextPack, StakesTier, UserScale, DetailLevel, PushThreshold } from '../../shared/types/pack.js';

export function PackEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) api.get<ContextPack>(`/api/packs/${projectId}`).then(setPack);
  }, [projectId]);

  if (!pack) return <p className="text-slate-400">Loading…</p>;

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

  return (
    <div className="space-y-6 rounded-lg border border-slate-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-slate-900">Edit {pack.identity.name}</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Identity</h2>
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.identity.name}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, name: e.target.value } })}
          />
        </label>
        <label className="block text-sm">
          Describe it in your own words
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.identity.owner_description}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, owner_description: e.target.value } })}
          />
        </label>
        <label className="block text-sm">
          Who uses it?
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.identity.audience ?? ''}
            onChange={(e) => setPack({ ...pack, identity: { ...pack.identity, audience: e.target.value } })}
          />
        </label>
      </section>

      {/* The three stakes questions, phrased exactly as in the schema doc. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Stakes</h2>

        <label className="block text-sm">
          Does anyone besides you use this?
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.stakes.has_external_users ? 'yes' : 'no'}
            onChange={(e) =>
              setPack({ ...pack, stakes: { ...pack.stakes, has_external_users: e.target.value === 'yes' } })
            }
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label className="block text-sm">
          Roughly how many?
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
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

        <label className="block text-sm">
          Does it touch money?
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.stakes.touches_money ? 'yes' : 'no'}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, touches_money: e.target.value === 'yes' } })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label className="block text-sm">
          Stakes tier
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.stakes.tier}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, tier: e.target.value as StakesTier } })}
          >
            <option value="sandbox">Sandbox</option>
            <option value="personal">Personal</option>
            <option value="live_small">Live (small)</option>
            <option value="live_critical">Live (critical)</option>
          </select>
        </label>

        <label className="block text-sm">
          If this goes down, what happens?
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.stakes.downtime_translation ?? ''}
            onChange={(e) => setPack({ ...pack, stakes: { ...pack.stakes, downtime_translation: e.target.value } })}
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Voice</h2>
        <label className="block text-sm">
          How much detail do you want?
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            value={pack.voice.detail_level}
            onChange={(e) => setPack({ ...pack, voice: { ...pack.voice, detail_level: e.target.value as DetailLevel } })}
          >
            <option value="plain_only">Just tell me what's happening</option>
            <option value="plain_expandable">Explain it, let me see details</option>
            <option value="technical_forward">I know my way around</option>
          </select>
        </label>
        <label className="block text-sm">
          When should I push a notification?
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
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

      {error && <p className="text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-40" disabled={saving} onClick={save}>
          Save
        </button>
        <button className="rounded px-4 py-1.5 text-sm text-slate-600" onClick={() => navigate('/projects')}>
          Cancel
        </button>
      </div>
    </div>
  );
}
