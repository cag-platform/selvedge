import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ProjectCard, type ProjectCardData } from '../components/ProjectRail.js';
import { Pane, btnPrimary, inputCls, labelCls, eyebrowCls } from '../components/ui.js';

function NewProjectForm({ onCreated }: { onCreated: (newProjectId?: string) => void }) {
  const [repos, setRepos] = useState<Array<{ full_name: string }>>([]);
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('__create__');
  const [manualRepo, setManualRepo] = useState('');
  // New things start as experiments — raise the stakes later, when it's real.
  const [tier, setTier] = useState('sandbox');
  const [touchesMoney, setTouchesMoney] = useState(false);
  const [downtime, setDowntime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Array<{ full_name: string }>>('/api/connectors/github/repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  // A brand-new repo means a brand-new thing: no users yet, nothing depends
  // on it, no money through it. Skip the stakes questions entirely — it
  // starts as a sandbox and the owner raises the stakes when it's real.
  const brandNew = repo === '__create__';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const pack = await api.post<{ identity: { project_id: string } }>('/api/packs', {
        name,
        ...(brandNew
          ? { create_repo: true, tier: 'sandbox', touches_money: false }
          : {
              repo: repo === '__manual__' ? manualRepo : repo,
              tier,
              touches_money: touchesMoney,
              downtime_translation: downtime || undefined,
            }),
      });
      onCreated(brandNew ? pack.identity.project_id : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const isLive = !brandNew && (tier === 'live_small' || tier === 'live_critical');

  return (
    <Pane className="mb-6 p-5">
      <form onSubmit={submit}>
        <h2 className="mb-3 text-headline font-display text-ink">New project</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Name
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Loom" required />
          </label>
          <label className={labelCls}>
            GitHub repo
            <select className={inputCls} value={repo} onChange={(e) => setRepo(e.target.value)} required>
              <option value="__create__">＋ Create a new private repo for it</option>
              {repos.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                </option>
              ))}
              <option value="__manual__">Type a repo by name…</option>
            </select>
            {repos.length === 0 && (
              // The picker is empty until the GitHub App is installed — say
              // so, and say the good part: installing IS the bulk import.
              <span className="mt-1 block text-meta text-ink-quiet">
                Already have apps on GitHub?{' '}
                <a href="/api/connectors/github/install" className="text-action-bright hover:underline">
                  Install the Selvedge GitHub App
                </a>{' '}
                and your repos appear here — each one becomes a project automatically.
              </span>
            )}
            {brandNew && (
              <span className="mt-1 block text-body text-ink-quiet">
                A private repo named after the project, made for you on GitHub. It starts as a
                sandbox — you land in the Workshop and just start building.
              </span>
            )}
            {repo === '__manual__' && (
              <input
                className={`${inputCls} mt-2`}
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value)}
                placeholder="owner/repo"
                required
              />
            )}
          </label>
          {!brandNew && (
            <label className={labelCls}>
              What is it?
              <select className={inputCls} value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="sandbox">Sandbox — an experiment</option>
                <option value="personal">Personal — just for me</option>
                <option value="live_small">Live — real people use it</option>
                <option value="live_critical">Live · critical — people depend on it</option>
              </select>
            </label>
          )}
          {isLive && (
            <label className={labelCls}>
              If it goes down, what does that mean? <span className="text-ink-quiet">(optional)</span>
              <input
                className={inputCls}
                value={downtime}
                onChange={(e) => setDowntime(e.target.value)}
                placeholder="customers can't check out"
              />
            </label>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between">
          {brandNew ? (
            <span />
          ) : (
            <label className="flex items-center gap-2 text-body text-ink-dim">
              <input type="checkbox" checked={touchesMoney} onChange={(e) => setTouchesMoney(e.target.checked)} />
              Money moves through it
            </label>
          )}
          <button type="submit" disabled={saving} className={btnPrimary}>
            {saving ? (brandNew ? 'Making the repo…' : 'Creating…') : brandNew ? 'Create & start building' : 'Create project'}
          </button>
        </div>
        {error && <p className="mt-2 text-body text-thread">{error}</p>}
      </form>
    </Pane>
  );
}

type StackMemory = { apps: number; watched_days: number; things_learned: number; summary: string };

/**
 * The moat made visible (Ironclad 1): a growing count of what Selvedge has
 * learned, and the honest anti-lock-in export. Being able to leave is what
 * makes people stay.
 */
function MemoryBanner() {
  const [mem, setMem] = useState<StackMemory | null>(null);
  useEffect(() => {
    api.get<StackMemory>('/api/memory').then(setMem).catch(() => setMem(null));
  }, []);
  if (!mem || mem.apps === 0) return null;

  const exportContext = async () => {
    const bundle = await api.get<unknown>('/api/export');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selvedge-context.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Pane className="mb-6 p-5">
      <p className="text-body text-ink">{mem.summary}</p>
      <button
        onClick={() => void exportContext()}
        className="mt-3 text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
      >
        Export my context →
      </button>
    </Pane>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();

  const load = () => api.get<ProjectCardData[]>('/api/projects').then(setProjects);
  useEffect(() => {
    void load();
  }, []);

  if (!projects) return <p className="text-body text-ink-quiet">Loading…</p>;

  return (
    <div className="animate-settle">
      <MemoryBanner />
      <div className="mb-4 flex items-center justify-between">
        <p className={eyebrowCls}>
          {projects.length === 0 ? 'No projects yet — connect GitHub, or create one' : 'Your stack · read the edges'}
        </p>
        <button onClick={() => setShowForm((v) => !v)} className={btnPrimary}>
          {showForm ? 'Close' : 'New project'}
        </button>
      </div>
      {(showForm || projects.length === 0) && (
        <NewProjectForm
          onCreated={(newProjectId) => {
            setShowForm(false);
            // A brand-new project goes straight to the Workshop — the point of
            // starting from nothing is to start building, not to file paperwork.
            if (newProjectId) {
              navigate(`/projects/${newProjectId}/workshop`);
              return;
            }
            void load();
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects.filter((p) => !p.muted).map((p) => (
          <ProjectCard key={p.project_id} project={p} />
        ))}
      </div>
      {projects.some((p) => p.muted) && (
        <details className="mt-6">
          <summary className="cursor-pointer text-label font-body uppercase tracking-widest text-ink-quiet">
            Muted · {projects.filter((p) => p.muted).length}
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.filter((p) => p.muted).map((p) => (
              <ProjectCard key={p.project_id} project={p} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
