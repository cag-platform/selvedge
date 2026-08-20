import { Link } from 'react-router-dom';
import { SelvedgeEdge } from './SelvedgeEdge.js';
import { AgentChip } from './AgentChip.js';
import { railOrder, whenShort, type InboxData, type ThreadRow } from '../lib/inbox.js';

/**
 * THE RAIL — every project, every conversation under it, and the morning brief
 * pinned at the top.
 *
 * It carries the product's oldest acceptance test into the new room: a stranger
 * reads the whole stack's health from the edges alone. So each project keeps
 * its selvedge edge and its plain health line, and the compact register only
 * takes away padding — never the sentence that says what the colour means.
 *
 * The unsorted tray appears here as one quiet line rather than a destination:
 * it is a thing to tell Selvedge once, not a place to go.
 */
export function Rail({
  data,
  activeThreadId,
  activeProjectId,
  onOpen,
  onOpenProject,
  onNewThread,
}: {
  data: InboxData | null;
  activeThreadId: string | null;
  activeProjectId: string | null;
  onOpen: (thread: ThreadRow) => void;
  onOpenProject: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
}) {
  if (!data) return <p className="p-work text-body text-ink-quiet">Loading…</p>;

  return (
    <nav aria-label="Projects and threads" className="flex h-full flex-col">
      {/* Read first, then work — the brief stays the front door, even in here. */}
      <div className="border-b border-hairline p-work">
        <Link
          to="/"
          className="block rounded-inset px-work-tight py-work-tight hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">This morning</p>
          <p className="font-display text-body-lg text-ink">{data.brief?.headline ?? 'No brief yet today.'}</p>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto p-work">
        {data.projects.length === 0 && (
          <p className="px-work-tight text-body text-ink-quiet">
            Nothing to watch yet. <Link to="/projects" className="text-action-bright hover:underline">Bring an app in</Link> and it turns up here.
          </p>
        )}

        {railOrder(data.projects).map((project) => (
          <section key={project.id} className="mb-work">
            <div
              className={`relative flex items-center justify-between rounded-inset px-work-tight py-work-tight ${
                project.id === activeProjectId ? 'bg-panel-soft' : ''
              }`}
            >
              <SelvedgeEdge status={project.status} />
              {/* The project's own name opens its history — what happened here,
                  which is a different question from what is being said in any
                  one conversation. */}
              <button
                onClick={() => onOpenProject(project.id)}
                title={`What happened to ${project.name}`}
                className="min-w-0 flex-1 pl-work text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
              >
                <p className="truncate text-body font-medium text-ink">{project.name}</p>
                {/* Colour is never the only signal: the health line says it in words. */}
                <p className="truncate text-meta text-ink-quiet">{project.health}</p>
              </button>
              <button
                onClick={() => onNewThread(project.id)}
                title="New thread here (Cmd+N)"
                className="ml-work shrink-0 rounded-inset px-work-tight text-meta text-ink-quiet hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
              >
                +
              </button>
            </div>

            <ul className="mt-work-tight">
              {project.threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    data-thread-row={thread.id}
                    onClick={() => onOpen(thread)}
                    aria-current={thread.id === activeThreadId ? 'true' : undefined}
                    className={`flex min-h-row-work w-full items-center gap-work px-work-tight py-work-tight text-left transition-colors duration-settle ease-settle focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
                      thread.id === activeThreadId ? 'rounded-inset bg-panel-soft' : 'hover:bg-panel-soft'
                    }`}
                  >
                    <AgentChip agent={thread.agent} working={thread.working} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink">{thread.title}</span>
                    </span>
                    <span className="shrink-0 font-mono text-tech text-ink-quiet">{whenShort(thread.last_at)}</span>
                  </button>
                </li>
              ))}
              {project.threads.length === 0 && (
                <li className="px-work-tight py-work-tight text-meta text-ink-quiet">No conversations yet — press + to start one.</li>
              )}
            </ul>
          </section>
        ))}
      </div>

      <div className="border-t border-hairline p-work text-meta text-ink-quiet">
        {data.unsorted_count > 0 ? (
          <Link to="/tray" className="hover:text-ink-dim">
            {data.unsorted_count} thing{data.unsorted_count === 1 ? '' : 's'} I couldn't place — tell me once where they belong.
          </Link>
        ) : (
          <span>Everything I've seen has a home.</span>
        )}
      </div>
    </nav>
  );
}
