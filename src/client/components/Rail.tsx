import { Link } from 'react-router-dom';
import { SelvedgeEdge } from './SelvedgeEdge.js';
import { AgentChip } from './AgentChip.js';
import { railPlaces, whenShort, type InboxData, type ThreadRow } from '../lib/inbox.js';

/**
 * THE RAIL — everywhere you work, and every conversation under it.
 *
 * ONE LIST. It used to carry two, under two headings, and the owner had to
 * know whether a thing was a "project" or a "subject" before they could start
 * a conversation about it. They are the same thing; one of them has code. So
 * the rail is one list ordered by what needs you, and the only difference is
 * what it can honestly say about each place.
 *
 * It carries the product's oldest acceptance test into the new room: a
 * stranger reads the whole stack's health from the edges alone. So a place
 * with code keeps its selvedge edge and its plain health line — and a place
 * without gets NEITHER, because a status on it would be a claim about nothing.
 *
 * Two things left the rail. The morning brief, because it is retired; and the
 * unsorted line, because filing what Selvedge has seen is settings work and
 * does not belong beside the work itself.
 */
export function Rail({
  data,
  activeThreadId,
  activeProjectId,
  onOpen,
  onOpenProject,
  onNewThread,
  onNewSubjectThread,
  onNewSubject,
}: {
  data: InboxData | null;
  activeThreadId: string | null;
  activeProjectId: string | null;
  onOpen: (thread: ThreadRow) => void;
  onOpenProject: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewSubjectThread: (subjectId: string) => void;
  onNewSubject: () => void;
}) {
  if (!data) return <p className="p-work text-body text-ink-quiet">Loading…</p>;

  return (
    <nav aria-label="Projects and threads" className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-work">
        {data.projects.length === 0 && (
          <p className="px-work-tight text-body text-ink-quiet">
            Nothing to watch yet. <Link to="/projects" className="text-action-bright hover:underline">Bring an app in</Link> and it turns up here.
          </p>
        )}

        {railPlaces(data.projects, data.subjects ?? []).map((place) => (
          <section key={place.id} className="mb-work">
            <div
              className={`relative flex items-center justify-between rounded-inset px-work-tight py-work-tight ${
                place.id === activeProjectId ? 'bg-panel-soft' : ''
              }`}
            >
              {/* No edge where there is no code: a status on a place that
                  cannot break would be a claim about nothing. */}
              {place.status && <SelvedgeEdge status={place.status} />}
              {place.hasCode ? (
                // The project's own name opens its history — what happened
                // here, which is a different question from what is being said
                // in any one conversation.
                <button
                  onClick={() => onOpenProject(place.id)}
                  title={`What happened to ${place.name}`}
                  className="min-w-0 flex-1 pl-work text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
                >
                  <p className="truncate text-body font-medium text-ink">{place.name}</p>
                  {/* Colour is never the only signal: the health line says it in words. */}
                  <p className="truncate text-meta text-ink-quiet">{place.health}</p>
                </button>
              ) : (
                <p className="min-w-0 flex-1 truncate pl-work text-body font-medium text-ink">{place.name}</p>
              )}
              <button
                onClick={() => (place.hasCode ? onNewThread(place.id) : onNewSubjectThread(place.id))}
                title={place.hasCode ? 'New thread here (Cmd+N)' : `New conversation about ${place.name}`}
                className="ml-work shrink-0 rounded-inset px-work-tight text-meta text-ink-quiet hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
              >
                +
              </button>
            </div>

            <ul className="mt-work-tight">
              {place.threads.map((thread) => (
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
              {place.threads.length === 0 && (
                <li className="px-work-tight py-work-tight text-meta text-ink-quiet">No conversations yet — press + to start one.</li>
              )}
            </ul>
          </section>
        ))}

        <button
          onClick={onNewSubject}
          className="mt-work w-full rounded-inset px-work-tight py-work-tight text-left text-meta text-ink-quiet hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          + somewhere to work that isn't a codebase
        </button>
      </div>
    </nav>
  );
}
