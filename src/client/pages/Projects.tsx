import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

type ProjectCard = {
  project_id: string;
  name: string;
  tier: string;
  health_line: string;
  links: { live_url?: string; repo_url?: string; host_dashboard_url?: string; store_listing_url?: string };
};

const TIER_LABEL: Record<string, string> = {
  sandbox: 'Sandbox',
  personal: 'Personal',
  live_small: 'Live',
  live_critical: 'Live · critical',
};

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [repos, setRepos] = useState<Array<{ full_name: string }>>([]);
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [tier, setTier] = useState('live_small');
  const [touchesMoney, setTouchesMoney] = useState(false);
  const [downtime, setDowntime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Array<{ full_name: string }>>('/api/connectors/github/repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post('/api/packs', {
        name,
        repo,
        tier,
        touches_money: touchesMoney,
        downtime_translation: downtime || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const isLive = tier === 'live_small' || tier === 'live_critical';

  return (
    <form onSubmit={submit} className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-semibold text-slate-900">New project</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-600">
          Name
          <input
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-slate-900"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Loom"
            required
          />
        </label>
        <label className="text-sm text-slate-600">
          GitHub repo
          {repos.length > 0 ? (
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              required
            >
              <option value="" disabled>
                Choose a repo…
              </option>
              {repos.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-slate-900"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              required
            />
          )}
        </label>
        <label className="text-sm text-slate-600">
          What is it?
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="sandbox">Sandbox — an experiment</option>
            <option value="personal">Personal — just for me</option>
            <option value="live_small">Live — real people use it</option>
            <option value="live_critical">Live · critical — people depend on it</option>
          </select>
        </label>
        {isLive && (
          <label className="text-sm text-slate-600">
            If it goes down, what does that mean? <span className="text-slate-400">(optional)</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-slate-900"
              value={downtime}
              onChange={(e) => setDowntime(e.target.value)}
              placeholder="customers can't check out"
            />
          </label>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={touchesMoney} onChange={(e) => setTouchesMoney(e.target.checked)} />
          Money moves through it
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create project'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = () => api.get<ProjectCard[]>('/api/projects').then(setProjects);
  useEffect(() => {
    void load();
  }, []);

  if (!projects) return <p className="text-slate-400">Loading…</p>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {projects.length === 0 ? 'No projects yet — create one to start watching a repo.' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          {showForm ? 'Close' : 'New project'}
        </button>
      </div>
      {(showForm || projects.length === 0) && (
        <NewProjectForm
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {projects.map((p) => (
        <div key={p.project_id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">{p.name}</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{TIER_LABEL[p.tier] ?? p.tier}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{p.health_line}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {p.links.live_url && (
              <a className="text-indigo-600 hover:underline" href={p.links.live_url} target="_blank" rel="noreferrer">
                Live site
              </a>
            )}
            {p.links.repo_url && (
              <a className="text-indigo-600 hover:underline" href={p.links.repo_url} target="_blank" rel="noreferrer">
                Repo
              </a>
            )}
            <Link className="text-indigo-600 hover:underline" to={`/projects/${p.project_id}/edit`}>
              Edit
            </Link>
          </div>
        </div>
        ))}
      </div>
    </div>
  );
}
