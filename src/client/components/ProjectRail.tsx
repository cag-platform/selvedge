import { Link } from 'react-router-dom';
import { SelvedgeEdge, type EdgeStatus } from './SelvedgeEdge.js';

/**
 * The project rail ("The Look", Prompt 4): frosted chips, one selvedge
 * edge each. The thesis in miniature — a stranger reads the stack's
 * health from the edges alone, before a single word.
 */

export type ProjectCardData = {
  project_id: string;
  name: string;
  tier: string;
  /** Both null when nothing has ever reported — see the server's hasHealthSignal. */
  health_line: string | null;
  edge: EdgeStatus | null;
  muted?: boolean;
};

const TIER_LABEL: Record<string, string> = {
  sandbox: 'sandbox',
  personal: 'personal',
  live_small: 'live',
  live_critical: 'live · critical',
};

export function ProjectCard({ project }: { project: ProjectCardData }) {
  return (
    <Link
      to={`/projects/${project.project_id}/edit`}
      // Solid --panel by budget: only nav + brief may blur (tokens.css).
      className="relative block rounded-card border border-hairline bg-panel p-4 pl-5 transition-colors duration-settle ease-settle hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
    >
      {project.edge && <SelvedgeEdge status={project.edge} />}
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-body font-medium text-ink">{project.name}</p>
        <p className="shrink-0 text-label uppercase tracking-widest text-ink-quiet">{TIER_LABEL[project.tier] ?? project.tier}</p>
      </div>
      {project.health_line && <p className="mt-1 truncate text-meta text-ink-dim">{project.health_line}</p>}
    </Link>
  );
}

export function ProjectRail({ projects }: { projects: ProjectCardData[] }) {
  if (projects.length === 0) return null;
  return (
    <section aria-label="Your stack">
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Your stack · read the edges</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <ProjectCard key={p.project_id} project={p} />
        ))}
      </div>
    </section>
  );
}
