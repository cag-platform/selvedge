import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SelvedgeEdge } from './SelvedgeEdge.js';
import { AgentChip } from './AgentChip.js';
import { railPlaces, splitPutAway, whenShort, type InboxData, type RailPlace, type ThreadRow } from '../lib/inbox.js';
import { putAwayLine, PUT_AWAY, BRING_BACK, PUT_AWAY_NOTE } from '../../shared/putAway.js';
import { EmptyState } from './ui.js';

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
 * ONE LIST YOU CAN STILL READ. The list is the right length at four places and
 * the wrong length at forty, and a rail you scroll past is a rail you stop
 * reading — which costs the product's oldest acceptance test, that a stranger
 * reads the whole stack's health from the edges alone. So a place you are not
 * working in can be put away: it leaves the list, keeps everything else, and
 * the count of what is folded is always on screen. See shared/putAway.ts.
 *
 * It carries that acceptance test into the new room: a place with code keeps
 * its selvedge edge and its plain health line — and a place without gets
 * NEITHER, because a status on it would be a claim about nothing.
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
  onStartIdea,
  onPutAway,
}: {
  data: InboxData | null;
  activeThreadId: string | null;
  activeProjectId: string | null;
  onOpen: (thread: ThreadRow) => void;
  onOpenProject: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewSubjectThread: (subjectId: string) => void;
  onNewSubject: () => void;
  onStartIdea: () => void;
  /** Fold a place away, or bring it back. */
  onPutAway: (place: RailPlace, away: boolean) => void;
}) {
  const [showingPutAway, setShowingPutAway] = useState(false);

  // The shape while it fills belongs to whoever owns the frame — the Inbox
  // renders RailSkeleton in this slot, so a word here would be a second
  // loading state fighting the first.
  if (!data) return null;

  const { atHand, putAway } = splitPutAway(railPlaces(data.projects, data.subjects ?? []));

  function row(place: RailPlace) {
    const active = (place.chat && place.chat.id === activeThreadId) || place.id === activeProjectId;
    return (
      // A container rather than one big button: the fold gesture is a button of
      // its own, and a button inside a button is not a thing a browser will
      // render.
      <div
        key={place.id}
        className={`group relative mb-work-tight flex w-full items-center rounded-inset transition-colors duration-settle ease-settle ${
          active ? 'bg-panel-soft' : 'hover:bg-panel-soft'
        }`}
      >
        <button
          data-thread-row={place.chat?.id}
          onClick={() => (place.chat ? onOpen(place.chat) : place.hasCode ? onNewThread(place.id) : onNewSubjectThread(place.id))}
          aria-current={place.chat && place.chat.id === activeThreadId ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-work px-work-tight py-work text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
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

        {/* Quiet until wanted, but never only on hover: focus reaches it too,
            or the gesture would exist for mice alone.

            OUT OF FLOW, WHICH IS THE WHOLE POINT. In the row's flex line this
            button reserved the width of "Bring back" on every row forever —
            about eighty pixels of a two-hundred-and-sixty pixel rail, invisible
            until you hovered, and taken directly out of the project name. Names
            were clipped to a few characters by a control nobody could see. It
            occupies no width now; it lifts off the row when wanted, over ground
            that was its own dead space anyway. */}
        <button
          onClick={() => onPutAway(place, !place.putAway)}
          title={place.putAway ? BRING_BACK : PUT_AWAY}
          aria-label={`${place.putAway ? BRING_BACK : PUT_AWAY}: ${place.name}`}
          className="absolute right-work-tight top-1/2 -translate-y-1/2 rounded-inset bg-panel-soft px-2 py-1 text-meta text-ink-quiet opacity-0 shadow-sm transition-opacity duration-settle ease-settle hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright group-hover:opacity-100"
        >
          {place.putAway ? BRING_BACK : PUT_AWAY}
        </button>
      </div>
    );
  }

  return (
    <nav aria-label="Projects and threads" className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-work">
        {atHand.length === 0 && putAway.length === 0 && (
          <div className="px-work-tight">
            <EmptyState
              action={
                <Link to="/projects" className="text-meta text-action-bright hover:underline">
                  Bring a repo in
                </Link>
              }
            >
              Nothing here yet. Bring a repo, or start with a question &mdash; a subject works before any code
              exists.
            </EmptyState>
          </div>
        )}

        {atHand.map(row)}

        {/* WHAT IS FOLDED IS NEVER HIDDEN. A row taken out of the list claims
            nothing; a row taken out of the list you cannot find again is the
            product lying about its own size. So the count is always here, and
            one press brings them back into view with their health lines. */}
        {putAway.length > 0 && (
          <div className="mt-work">
            <button
              onClick={() => setShowingPutAway((v) => !v)}
              aria-expanded={showingPutAway}
              className="w-full rounded-inset px-work-tight py-work-tight text-left text-meta text-ink-quiet hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            >
              {putAwayLine(putAway.length)} · {showingPutAway ? 'hide' : 'show'}
            </button>
            {showingPutAway && (
              <div className="mt-work-tight">
                <p className="px-work-tight pb-work-tight text-meta text-ink-quiet">{PUT_AWAY_NOTE}</p>
                {putAway.map(row)}
              </div>
            )}
          </div>
        )}

        {/*
          START AN IDEA — the front door to a plain conversation, above the
          quieter "make a place" because it is what somebody actually wants to
          do. It is not a new kind of thing: an idea is a conversation under a
          subject, which is what a subject already is.

          Worded as a door that happens to be there, not a step you are failing
          to take. Most ideas never become projects, and that is correct — a
          product that framed this as a funnel would make ninety percent of what
          you write here read as unfinished.
        */}
        <button
          onClick={onStartIdea}
          className="mt-work w-full rounded-inset px-work-tight py-work-tight text-left text-body text-ink-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          + Start an idea
        </button>
        <button
          onClick={onNewSubject}
          className="w-full rounded-inset px-work-tight py-work-tight text-left text-meta text-ink-quiet hover:text-ink-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          + somewhere to work that isn’t a codebase
        </button>
      </div>
    </nav>
  );
}
