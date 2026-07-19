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

export function Projects() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);

  useEffect(() => {
    api.get<ProjectCard[]>('/api/projects').then(setProjects);
  }, []);

  if (!projects) return <p className="text-slate-400">Loading…</p>;
  if (projects.length === 0) return <p className="text-slate-500">No projects yet — connect GitHub to get started.</p>;

  return (
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
  );
}
