import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeEdge } from '../components/SelvedgeEdge.js';
import { EmptyState, eyebrowCls } from '../components/ui.js';
import { placeLines, railPlaces, splitPutAway, whenShort, type InboxData, type RailPlace } from '../lib/inbox.js';

/**
 * THE FRONT DOOR — a question, then your work.
 *
 * `/` used to redirect into the Inbox, which opens the most recent
 * conversation on arrival, so every visit landed mid-sentence inside one
 * project's workshop. The first cut of this page fixed the landing but led
 * with a wall of status; the owner's verdict on that was "clinical", and they
 * were right. What you want from a front door is what Replit's gets right: it
 * asks you a question, and your work is one glance below.
 *
 * SO THE COMPOSER IS THE PAGE. Typing here starts an idea — a plain
 * conversation about nothing in particular yet, because the point of an idea
 * is that you do not know yet. It lands under the Ideas subject, the first
 * message names it (see titleFromFirstMessage), and naming a builder later is
 * what turns it into a project. The whole idea→build path this product
 * already has, entered by answering a question.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 * - Status and corrections. Reading a correction is what acknowledges it, and
 *   exactly one surface may own that act — /api/status marks incidents
 *   acknowledged on read, so a page that fetched it without leading with it
 *   would silently burn corrections nobody saw. They live on Projects.
 * - Suggested prompts. Replit fills this space with guesses; a guessed chip
 *   that produces a bad answer costs more trust than an empty space costs
 *   delight.
 * - A live preview. Waking a sandbox takes a minute and starts the meter —
 *   the wrong bill for a page you pass through.
 */

export function Home() {
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<InboxData>('/api/inbox')
      .then(setInbox)
      .catch(() => setInbox({ projects: [], subjects: [], engine_on: false }));
  }, []);

  const places = inbox ? splitPutAway(railPlaces(inbox.projects, inbox.subjects ?? [])).atHand : [];

  return (
    <div className="animate-settle space-y-10 pt-6 sm:pt-12">
      <Ask />

      {inbox && places.length === 0 && (
        <EmptyState
          action={
            <span className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              <Link to="/projects" className="text-meta text-action-bright hover:underline">
                Bring a repo in
              </Link>
              {/* The other way an app arrives: as a Repl zip. Deep-links the
                  Projects page with the import already open. */}
              <Link to="/projects?import=replit" className="text-meta text-action-bright hover:underline">
                Import from Replit
              </Link>
            </span>
          }
        >
          Nothing here yet. Ask something above, or bring a repo &mdash; a conversation works before any code exists.
        </EmptyState>
      )}

      {places.length > 0 && (
        <section aria-label="Jump back in">
          <p className={`mb-3 ${eyebrowCls}`}>Jump back in</p>
          {/* The rail's own order — most recently used first — so the card
              top-left IS where you left off, with no second notion of
              "recent" that could disagree with the Inbox. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {places.map((place) => (
              <PlaceCard key={place.id} place={place} onOpen={() => openPlace(place, navigate)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The question, and the box that answers it. Submitting starts an idea and
 * says the first thing in it — one gesture, no ceremony about what kind of
 * thing it is, because the point of an idea is that you don't know yet.
 */
function Ask() {
  /**
   * The name comes off the loaded Clerk instance rather than the useUser hook.
   * This page only renders inside <SignedIn>, where Clerk is already loaded —
   * and the hook throws outside a ClerkProvider, which would make a GREETING
   * the reason the screenshot harness cannot mount the page. A missing name
   * costs one word; a provider dependency costs the page its testability.
   */
  const first = (window as { Clerk?: { user?: { firstName?: string | null } } }).Clerk?.user?.firstName?.trim();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  async function start() {
    const text = draft.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const made = await api.post<{ thread: { id: string } }>('/api/ideas', {});
      await api.post(`/api/threads/${made.thread.id}/message`, { text });
      navigate(`/inbox/${made.thread.id}`);
    } catch (e) {
      // The draft is kept: a failed send must never eat the sentence.
      setNote(e instanceof Error ? e.message : "that didn't go through");
      setBusy(false);
    }
  }

  return (
    <section aria-label="Start something" className="mx-auto max-w-xl text-center">
      <h1 className="font-display text-section font-medium text-ink">
        {first ? `${first}, what are we building today?` : 'What are we building today?'}
      </h1>

      <div className="mt-6 rounded-pane border border-hairline bg-panel p-3 text-left shadow-sm focus-within:border-action">
        <textarea
          ref={box}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          rows={2}
          disabled={busy}
          placeholder="Describe it, or just ask — a question is a fine place to start"
          className="block w-full resize-none bg-transparent px-1 py-1 text-body-lg text-ink placeholder:text-ink-quiet focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-between pt-2">
          {/* The way out of "just talking" is named where the talking starts:
              the same @-mention that moves any conversation to a builder. */}
          <p className="px-1 text-meta text-ink-quiet">
            Name a builder when it should become code &mdash; <span className="font-mono text-tech">@claudecode</span> takes it from
            there.
          </p>
          <button
            onClick={() => void start()}
            disabled={busy || draft.trim() === ''}
            className="shrink-0 rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-40"
          >
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>

      {note && <p className="mt-2 text-meta text-thread">{note}</p>}
    </section>
  );
}

/** Where tapping a place goes. A place with no conversation yet has nothing to open, so it lands on the Inbox, which knows how to start one. */
function openPlace(place: RailPlace, navigate: (to: string) => void): void {
  navigate(place.chat ? `/inbox/${place.chat.id}` : '/inbox');
}

function PlaceCard({ place, onOpen }: { place: RailPlace; onOpen: () => void }) {
  const lines = placeLines(place);
  return (
    <button
      onClick={onOpen}
      className="relative block w-full rounded-card border border-hairline bg-panel p-4 pl-5 text-left transition-colors duration-settle ease-settle hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
    >
      {place.status && <SelvedgeEdge status={place.status} />}
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-body font-medium text-ink">{place.name}</p>
        {place.chat && <p className="shrink-0 font-mono text-tech text-ink-quiet">{whenShort(place.chat.last_at)}</p>}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-meta text-ink-quiet">{lines.said}</p>
        {place.chat && <AgentChip agent={place.chat.agent} working={place.chat.working} />}
      </div>
      {lines.note && <p className="mt-1 truncate text-meta text-thread">{lines.note}</p>}
    </button>
  );
}
