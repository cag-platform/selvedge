import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SelvedgeEdge, type EdgeStatus } from './SelvedgeEdge.js';
import { TimelineTab } from './TimelineTab.js';

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
  /** The accounts behind it, as server-built doors — see connectors/consoles.ts. */
  console_links?: Array<{ provider: string; label: string; url: string }>;
  muted?: boolean;
};

const TIER_LABEL: Record<string, string> = {
  sandbox: 'sandbox',
  personal: 'personal',
  live_small: 'live',
  live_critical: 'live · critical',
};

/**
 * ONE PROJECT, AND EVERYTHING THAT HAPPENED TO IT.
 *
 * The card used to be a link to the pack editor and nothing else: a name, a
 * tier chip, and a health line that most projects do not have. Twenty of them
 * in a grid read as a directory of words — you could not tell which ones were
 * alive, and the only thing a click did was open a settings form nobody wanted.
 *
 * So the card opens. Underneath is the record that already existed and had
 * nowhere to be read from here: every ask, ship, undo, verdict and handover,
 * one plain sentence each, with the evidence a click beneath. The test is that
 * you can answer "what happened here in the last two weeks?" without opening a
 * conversation.
 *
 * IT LOADS NOTHING UNTIL IT IS OPENED. Twenty projects' worth of history
 * fetched to render a grid nobody has clicked is twenty requests spent on a
 * question nobody asked — so the timeline mounts on expand and not before.
 *
 * EDITING MOVED TO A LINK. A whole card that navigates to a form is why
 * expanding it was impossible; the pack editor is one small link in the open
 * card now, where somebody looking for it will find it and nobody else has to.
 */
export function ProjectCard({ project }: { project: ProjectCardData }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div
      // AN OPEN CARD TAKES THE WHOLE ROW. The record is a reading surface —
      // sentences, dates, evidence — and half of a two-column grid is not a
      // column you can read one in.
      className={`relative rounded-card border bg-panel transition-colors duration-settle ease-settle ${
        open ? 'border-action sm:col-span-2 lg:col-span-3' : 'border-hairline hover:border-action'
      }`}
    >
      {project.edge && <SelvedgeEdge status={project.edge} />}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="block w-full rounded-card p-4 pl-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
      >
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-body font-medium text-ink">{project.name}</p>
          <p className="shrink-0 text-label uppercase tracking-widest text-ink-quiet">
            {TIER_LABEL[project.tier] ?? project.tier}
          </p>
        </div>
        {/* A health line where there is one. Where there isn't, the card says
            what it can honestly offer instead — the record — rather than
            leaving a blank second line that reads as a missing value. */}
        <p className="mt-1 truncate text-meta text-ink-dim">
          {project.health_line ?? (open ? 'What happened here' : 'Open for what happened here')}
        </p>
      </button>

      {open && (
        <div className="border-t border-hairline px-4 pb-4 pl-5">
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            {/* The accounts behind it: Railway variables, the database console,
                the repo. Server-built URLs (connectors/consoles.ts) — the card
                only opens doors, it never guesses where one leads. */}
            <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
              {(project.console_links ?? []).map((door) => (
                <a
                  key={door.url}
                  href={door.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-meta text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
                >
                  {door.provider} — {door.label} ↗
                </a>
              ))}
            </div>
            <Link
              to={`/projects/${project.project_id}/edit`}
              className="shrink-0 text-meta text-ink-quiet underline hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            >
              Edit this project
            </Link>
          </div>
          {/* The record's own surface, reused whole. A second implementation of
              "what happened here" would be a second thing to keep true. */}
          <TimelineTab projectId={project.project_id} onOpenThread={(threadId) => navigate(`/inbox/${threadId}`)} />
        </div>
      )}
    </div>
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
