import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { MigrationSource } from '../../shared/types/migration.js';

type Repo = { full_name: string };
type Intake = { project_id: string; thread_id: string; repo: string };

export function ImportGithub({ source }: { source: Extract<MigrationSource, 'github' | 'codex' | 'claude-code' | 'cursor' | 'lovable'> }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'inspecting' | 'preparing' | 'opening'>('idle');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => { api.get<Repo[]>('/api/connectors/github/repos').then((items) => { setRepos(items); setRepo((current) => current || items[0]?.full_name || ''); }).catch(() => setRepos([])); }, []);

  async function start() {
    if (!repo || busy) return;
    setBusy(true); setError(null); setPhase('inspecting');
    try {
      const intake = await api.post<Intake>('/api/import/github', { repo, source });
      setPhase('preparing');
      const workspace = await api.post(`/api/projects/${encodeURIComponent(intake.project_id)}/migration/workspace`, {}).catch(() => null);
      setPhase('opening');
      await api.post(`/api/threads/${intake.thread_id}/message`, { text: workspace ? 'Continue this migration automatically in the isolated workspace Selvedge prepared. Start the development preview, verify the migrated project independently, and tell me only what still needs my access or approval. Do not change production or ship anything.' : 'Continue this GitHub migration automatically. Inspect the migration plan, explain the workspace blocker plainly, and resolve anything that does not require my access. Do not change production or ship anything.', mode: 'build' }).catch(() => undefined);
      navigate(`/inbox/${intake.thread_id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Selvedge could not start that migration.'); setBusy(false); setPhase('idle'); }
  }

  if (repos === null) return <p className="mt-5 text-body text-ink-dim">Reading the repositories your GitHub App can access…</p>;
  if (!repos.length) return <div className="mt-5 rounded-inset border border-hairline bg-panel-soft p-4"><p className="text-body text-ink">Connect GitHub once, then choose the repository here.</p><a href="/api/connectors/github/install" className="mt-3 inline-block rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">Install the Selvedge GitHub App →</a></div>;
  return <div className="mt-5 rounded-card border border-hairline bg-panel-soft p-4"><label className="text-meta text-ink-dim">Which repository holds the project?<select value={repo} onChange={(event) => setRepo(event.target.value)} disabled={busy} className="mt-1 block w-full rounded-inset border border-hairline bg-panel px-3 py-2.5 text-body text-ink">{repos.map((item) => <option key={item.full_name} value={item.full_name}>{item.full_name}</option>)}</select></label><button type="button" onClick={() => void start()} disabled={!repo || busy} className="mt-3 rounded-full bg-action px-5 py-2.5 text-body font-medium text-white disabled:opacity-40">{phase === 'inspecting' ? 'Inspecting repository…' : phase === 'preparing' ? 'Preparing preview…' : phase === 'opening' ? 'Opening migration…' : 'Let Selvedge migrate it →'}</button>{busy && <p className="mt-3 text-meta text-ink-dim">Preparing your project…</p>}{error && <p role="alert" className="mt-3 text-meta text-thread">{error}</p>}</div>;
}
