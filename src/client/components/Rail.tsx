import { Link } from 'react-router-dom';
import { SelvedgeEdge } from './SelvedgeEdge.js';
import { AgentChip } from './AgentChip.js';
import { railPlaces, whenShort, type InboxData, type ThreadRow } from '../lib/inbox.js';

/**
 * THE RAIL — everywhere you work. One row each, one conversation each.
 *
 * ONE LIST. It used to carry two, under two headings, and the owner had to
 * know whether a thing was a "project" or a "subject" before they could start
 * a conversation about it. They are the same thing; one of them has code. So
 * the rail is one list ordered by what needs you, and the only difference is
 * what it can honestly say about each place.
 *
 * ONE CHAT. It also used to nest a list of threads under every project, which
 * in practice split by agent — "GPT Workshop" above "CC Workshop", the same
 * project, the same work, two rooms. That is precisely the wall the @-mention
 * model took down, drawn back on in the navigation. A project has one
 * conversation; naming somebody moves it, and the chip on the row says who has
 * it now.
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
          <button
            key={place.id}
            data-thread-row={place.chat?.id}
            onClick={() => (place.chat ? onOpen(place.chat) : place.hasCode ? onNewThread(place.id) : onNewSubjectThread(place.id))}
            aria-current={place.chat && place.chat.id === activeThreadId ? 'true' : undefined}
            className={`relative mb-work-tight flex w-full items-center gap-work rounded-inset px-work-tight py-work text-left transition-colors duration-settle ease-settle focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
              (place.chat && place.chat.id === activeThreadId) || place.id === activeProjectId ? 'bg-panel-soft' : 'hover:bg-panel-soft'
            }`}
          >
            {/* Two different silences, one rule: say nothing. No code here to
                be healthy or broken, or nothing has ever reported on the code
                that is. A dashed edge is for "I looked and couldn't tell". */}
            {place.status && <SelvedgeEdge status={place.status} />}

            <span className="min-w-0 flex-1 pl-work">
              <span className="flex items-baseline gap-work">
                <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">{place.name}</span>
                {place.chat && (
                  <span className="shrink-0 font-mono text-tech text-ink-quiet">{whenShort(place.chat.last_at)}</span>
                )}
              </span>
              {/* Colour is never the only signal — but where there is no
                  signal, there is no sentence either. */}
              {place.health && <span className="block truncate text-meta text-ink-quiet">{place.health}</span>}
              {!place.chat && (
                <span className="block truncate text-meta text-ink-quiet">Nothing said here yet — open it and start.</span>
              )}
            </span>

            {/* Who is on it right now. One conversation per project, so this is
                the whole answer rather than one row of a list. */}
            {place.chat && <AgentChip agent={place.chat.agent} working={place.chat.working} />}
          </button>
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
