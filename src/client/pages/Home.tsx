import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeEdge } from '../components/SelvedgeEdge.js';
import { SituationCard, type SituationEvent } from '../components/SituationCard.js';
import { EmptyState, eyebrowCls } from '../components/ui.js';
import { placeLines, railPlaces, splitPutAway, whenShort, type InboxData, type RailPlace } from '../lib/inbox.js';

/**
 * THE FRONT DOOR — which used to be somebody else's workshop.
 *
 * `/` redirected to `/inbox`, and the Inbox opens the most recent conversation
 * on arrival. Both of those are right on their own: a workbench should reopen
 * where you were. Together they meant the app had no home at all — every visit
 * landed mid-sentence inside one project's build thread, whatever you had come
 * to do, and there was nowhere that showed you the shape of your own work.
 *
 * So home is its own place now. The Inbox keeps its behaviour, because that IS
 * the workbench and reopening the last conversation is what a workbench should
 * do. This is the room you walk through first.
 *
 * WHAT IT IS ALLOWED TO SAY. Everything here is already on screen elsewhere —
 * it invents no metric, computes no score, and adds no request the app was not
 * making. A dashboard's temptation is to fill space with numbers that look like
 * insight; the honest version shows you what you were doing, what you have, and
 * what happened, and then gets out of the way.
 */

type StatusResponse = { corrections: Array<{ id: string; line: string }>; live: SituationEvent[] };

export function Home() {
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [status, setStatus] = useState<StatusResponse>({ corrections: [], live: [] });
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<InboxData>('/api/inbox')
      .then(setInbox)
      .catch(() => setInbox({ projects: [], subjects: [], engine_on: false }));
    // Status must never be able to blank the page: a home that renders without
    // it is degraded, one that doesn't render at all is broken.
    api
      .get<StatusResponse>('/api/status')
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  if (!inbox) return null;

  const { atHand } = splitPutAway(railPlaces(inbox.projects, inbox.subjects ?? []));
  // The rail is already ordered by when you were last there, so the first row
  // IS where you left off — no second notion of "recent" that could disagree.
  const [latest, ...rest] = atHand;
  const live = status.live.filter((n) => n.projectId !== null || n.eventType === 'connector.auth_failed');

  return (
    <div className="animate-settle space-y-8">
      {/* CORRECTIONS LEAD AND ARE NEVER FOLDED. When Selvedge said something
          was fine and it wasn't, owning it out loud is the whole basis for
          believing it the rest of the time — so it outranks even the thing you
          were in the middle of. */}
      {status.corrections.length > 0 && (
        <section aria-label="Corrections" className="rounded-card border border-hairline border-l-2 border-l-thread bg-panel-soft px-4 py-3">
          <p className="text-label font-body uppercase tracking-widest text-thread">Correcting myself</p>
          {status.corrections.map((c) => (
            <p key={c.id} className="mt-1 text-body text-ink">
              {c.line}
            </p>
          ))}
        </section>
      )}

      {latest ? (
        <WhereYouLeftOff place={latest} onOpen={() => openPlace(latest, navigate)} />
      ) : (
        <EmptyState action={<Link to="/projects" className="text-meta text-action-bright hover:underline">Bring a repo in</Link>}>
          Nothing here yet. Bring a repo, or start with a question &mdash; a subject works before any code exists.
        </EmptyState>
      )}

      {rest.length > 0 && (
        <section aria-label="Everywhere else">
          <p className={`mb-3 ${eyebrowCls}`}>Everywhere else</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {rest.map((place) => (
              <PlaceRow key={place.id} place={place} onOpen={() => openPlace(place, navigate)} />
            ))}
          </div>
        </section>
      )}

      {/* Folded, and counted. This was an open wall of narration cards on the
          Projects page; on a real account it is the whole screen. */}
      {live.length > 0 && (
        <details className="rounded-card border border-hairline bg-panel-soft px-4 py-3">
          <summary className={`cursor-pointer ${eyebrowCls}`}>Since yesterday · {live.length}</summary>
          <div className="mt-3 space-y-3">
            {live.map((n) => (
              <SituationCard key={n.id} event={n} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Where tapping a place goes, in one function, so the card at the top and the
 * rows under it can never land somewhere different. A place with no
 * conversation yet has nothing to open, so it goes to the Inbox, which knows
 * how to start one.
 */
function openPlace(place: RailPlace, navigate: (to: string) => void): void {
  navigate(place.chat ? `/inbox/${place.chat.id}` : '/inbox');
}

/**
 * The one thing on this page bigger than a row: the conversation you were last
 * in, with the room to say what it was about.
 *
 * NO LIVE PREVIEW IN HERE, deliberately. Waking a sandbox takes about a minute
 * and starts the meter, and doing that on every visit to the front door is a
 * real bill for something most visits scroll past. The preview stays one click
 * in, inside the conversation, where asking for it is a decision.
 */
function WhereYouLeftOff({ place, onOpen }: { place: RailPlace; onOpen: () => void }) {
  const lines = placeLines(place);
  return (
    <section aria-label="Where you left off">
      <p className={`mb-3 ${eyebrowCls}`}>Where you left off</p>
      <button
        onClick={onOpen}
        className="relative block w-full rounded-pane border border-hairline bg-panel p-6 pl-7 text-left transition-colors duration-settle ease-settle hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
      >
        {place.status && <SelvedgeEdge status={place.status} />}
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-headline font-display text-ink">{place.name}</p>
          {place.chat && <p className="shrink-0 font-mono text-tech text-ink-quiet">{whenShort(place.chat.last_at)}</p>}
        </div>
        <p className="mt-2 text-body-lg text-ink-dim">{lines.said}</p>
        {lines.note && <p className="mt-1 text-meta text-thread">{lines.note}</p>}
        {place.chat && (
          <div className="mt-4 flex items-center gap-work">
            <AgentChip agent={place.chat.agent} working={place.chat.working} />
            <span className="text-meta text-ink-quiet">pick it up</span>
          </div>
        )}
      </button>
    </section>
  );
}

function PlaceRow({ place, onOpen }: { place: RailPlace; onOpen: () => void }) {
  const lines = placeLines(place);
  return (
    <button
      onClick={onOpen}
      className="relative flex w-full items-center gap-work rounded-card border border-hairline bg-panel px-4 py-3 pl-5 text-left transition-colors duration-settle ease-settle hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
    >
      {place.status && <SelvedgeEdge status={place.status} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-work">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">{place.name}</span>
          {place.chat && <span className="shrink-0 font-mono text-tech text-ink-quiet">{whenShort(place.chat.last_at)}</span>}
        </span>
        <span className="block truncate text-meta text-ink-quiet">{lines.said}</span>
      </span>
      {place.chat && <AgentChip agent={place.chat.agent} working={place.chat.working} />}
    </button>
  );
}
