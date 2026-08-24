import { describe, it, expect } from 'vitest';
import {
  allThreads,
  matches,
  placeLines,
  railPlaces,
  splitPutAway,
  whenShort,
  NOTHING_SAID,
  type ProjectRow,
  type SubjectRow,
} from '../../src/client/lib/inbox.js';
import { putAwayLine } from '../../src/shared/putAway.js';

const project = (over: Partial<ProjectRow>): ProjectRow => ({
  id: 'p',
  name: 'P',
  status: 'healthy',
  health: 'fine',
  threads: [],
  ...over,
});

/**
 * The rail's rules, tested away from the browser. Ordering is asserted
 * through `railPlaces` below — the only function that decides it now, since
 * projects and subjects share one order and a separate projects-only sort
 * could only disagree with it.
 */
describe('the rail', () => {
  it('flattens every thread with the project it belongs to, for the palette', () => {
    const flat = allThreads({
      projects: [
        project({
          id: 'loom',
          name: 'Loom',
          threads: [{ id: 't1', kind: 'workshop', title: 'Checkout', agent: 'claude-code', chip: 'CC', working: false, last_at: '2026-08-01' }],
        }),
      ],
      brief: null,
      unsorted_count: 0,
      engine_on: true,
    });
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ id: 't1', projectId: 'loom', projectName: 'Loom' });
    expect(allThreads(null)).toEqual([]);
  });

  it('says when something happened the way a person would', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    expect(whenShort('2026-08-20T09:30:00Z', now)).toMatch(/\d/); // a time today
    expect(whenShort('2026-08-19T09:30:00Z', now)).toBe('yesterday');
    expect(whenShort('2026-08-17T09:30:00Z', now)).toBe('3 days ago');
    expect(whenShort('2026-06-01T09:30:00Z', now)).toMatch(/Jun/);
    expect(whenShort('not a date', now)).toBe('');
  });

  it('matches on any of the fields it is given, and an empty query matches everything', () => {
    expect(matches('check', 'Checkout rework', 'Loom')).toBe(true);
    expect(matches('loom', 'Checkout rework', 'Loom')).toBe(true);
    expect(matches('  ', 'anything')).toBe(true);
    expect(matches('nope', 'Checkout rework', 'Loom')).toBe(false);
  });
});

/**
 * ONE LIST, ONE WORD.
 *
 * The rail carried two lists under two headings, and the owner had to know
 * whether a thing was a "project" or a "subject" before they could start a
 * conversation about it. They are the same thing; one of them has code.
 *
 * The honesty rule that survives is about what the rail may CLAIM: a place
 * with no code gets no status, because a status on it would be a claim about
 * nothing.
 *
 * THE ORDER IS NO LONGER HEALTH. The rail sorted by the edge vocabulary while
 * the product's question was "what needs me this morning?" — it isn't any
 * more. This is where somebody keeps everything they are building, and what
 * you want on opening it is what you were last doing. Health-first also
 * collapsed in practice: most places have never reported anything, so they all
 * landed in one rank and the list degraded to alphabetical.
 */
describe('the rail, as one list', () => {
  const subject = (over: Partial<SubjectRow>): SubjectRow => ({ id: 's', name: 'S', threads: [], ...over });

  it('says nothing about a place with no code, rather than saying it is fine', () => {
    const [place] = railPlaces([], [subject({ id: 'pricing', name: 'Pricing' })]);
    expect(place!.status).toBeNull();
    expect(place!.health).toBeNull();
    expect(place!.hasCode).toBe(false);
  });

  const chatAt = (at: string) => [{ id: `t_${at}`, last_at: at } as never];

  it('puts where you were last at the top, whatever its health says', () => {
    const places = railPlaces(
      [
        project({ id: 'a', name: 'Alpha', status: 'healthy', threads: chatAt('2026-08-24T09:00:00Z') }),
        project({ id: 'b', name: 'Bravo', status: 'unknown', threads: chatAt('2026-08-20T09:00:00Z') }),
        project({ id: 'c', name: 'Charlie', status: 'needs', threads: chatAt('2026-08-01T09:00:00Z') }),
        project({ id: 'd', name: 'Delta', status: 'working', threads: chatAt('2026-08-22T09:00:00Z') }),
      ],
      [],
    );
    expect(places.map((p) => p.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('mixes places with and without code into one order — recency does not care which has a repo', () => {
    // The merge was supposed to remove "which of these am I in?", and keeping
    // every subject below every project drew that line straight back on. An
    // idea from five minutes ago belongs above a repo last touched in March.
    const places = railPlaces(
      [project({ id: 'loom', name: 'Loom', status: 'needs', threads: chatAt('2026-03-01T09:00:00Z') })],
      [{ ...subject({ id: 'idea', name: 'Idea' }), threads: chatAt('2026-08-24T09:00:00Z') }],
    );
    expect(places.map((p) => p.id)).toEqual(['idea', 'loom']);
  });

  it('sinks a place nobody has said anything in, because it has no recency to sort by', () => {
    const places = railPlaces(
      [
        project({ id: 'fresh', name: 'Fresh' }),
        project({ id: 'used', name: 'Used', threads: chatAt('2026-01-01T09:00:00Z') }),
      ],
      [],
    );
    expect(places.map((p) => p.id)).toEqual(['used', 'fresh']);
  });

  it('breaks ties by name, so nothing reshuffles under you', () => {
    // Two never-used places, and two used at the same moment, both read
    // alphabetically rather than in whatever order the payload arrived.
    expect(railPlaces([], [subject({ id: 'z', name: 'Zulu' }), subject({ id: 'a', name: 'Alpha' })]).map((p) => p.name)).toEqual([
      'Alpha',
      'Zulu',
    ]);
    const sameMoment = railPlaces(
      [
        project({ id: 'z', name: 'Zulu', threads: chatAt('2026-08-24T09:00:00Z') }),
        project({ id: 'a', name: 'Alpha', threads: chatAt('2026-08-24T09:00:00Z') }),
      ],
      [],
    );
    expect(sameMoment.map((p) => p.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('carries every conversation through the merge — nothing is dropped by being re-sorted', () => {
    const places = railPlaces(
      [project({ id: 'loom', name: 'Loom', threads: [{ id: 't1' } as never] })],
      [subject({ id: 'pricing', name: 'Pricing', threads: [{ id: 't2' } as never, { id: 't3' } as never] })],
    );
    expect(places.flatMap((p) => p.threads).map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

/**
 * PUT AWAY — the fold in the rail.
 *
 * The rail is one list, and it is the right length at four places and the
 * wrong length at forty. What is tested here is the property that makes the
 * fold honest rather than a filter: what comes back keeps the order the rail
 * already computed, so bringing a place back puts it where it belongs instead
 * of at the end of the list.
 */
describe('a place folded out of the rail', () => {
  const subject = (over: Partial<SubjectRow>): SubjectRow => ({ id: 's', name: 'S', threads: [], ...over });
  const away = (row: ProjectRow) => ({ ...row, put_away: true });

  it('separates what is at hand from what is folded, keeping the rail order', () => {
    const places = railPlaces(
      [
        away(project({ id: 'old', name: 'Old thing', status: 'needs', threads: [{ id: 'to', last_at: '2026-08-24T09:00:00Z' } as never] })),
        project({ id: 'live', name: 'Live', status: 'healthy', threads: [{ id: 'tl', last_at: '2026-08-01T09:00:00Z' } as never] }),
        project({ id: 'broken', name: 'Broken', status: 'needs', threads: [{ id: 'tb', last_at: '2026-08-20T09:00:00Z' } as never] }),
      ],
      [],
    );
    const { atHand, putAway } = splitPutAway(places);
    // The rail's order is kept inside the half that is at hand — the most
    // recently used first, with the folded one out of the way entirely even
    // though it is the most recent of the three.
    expect(atHand.map((p) => p.id)).toEqual(['broken', 'live']);
    // ...and the folded one is folded regardless of what its status says.
    expect(putAway.map((p) => p.id)).toEqual(['old']);
  });

  it('folds a place with no repo the same way', () => {
    const places = railPlaces([], [{ ...subject({ id: 'pricing', name: 'Pricing' }), put_away: true }]);
    expect(splitPutAway(places).putAway.map((p) => p.id)).toEqual(['pricing']);
  });

  it('treats a row that says nothing about it as at hand', () => {
    // An older server, or any payload that predates the flag. Silence means
    // present: a place must never disappear because a field was absent.
    const places = railPlaces([project({ id: 'loom', name: 'Loom' })], [subject({ id: 's', name: 'S' })]);
    expect(splitPutAway(places).putAway).toEqual([]);
    expect(splitPutAway(places).atHand).toHaveLength(2);
  });

  it('names the fold the way a person would count', () => {
    expect(putAwayLine(1)).toBe('1 put away');
    expect(putAwayLine(3)).toBe('3 put away');
    // Nothing folded is nothing said — the rail shows no line at all.
    expect(putAwayLine(0)).toBe('');
  });
});

/**
 * WHAT A ROW ACTUALLY SAYS, which for most rows was nothing.
 *
 * The second line used to be the health line and only the health line. A
 * health signal needs a host connector delivering deploy events, or the app to
 * have been put online through Selvedge — so on a real account almost nothing
 * has one, and almost every row carried a name, a timestamp and a two-letter
 * chip. Twelve names in a column with no way to tell them apart.
 */
describe('the second line of a row', () => {
  const chat = (title: string) => ({ id: 't', kind: 'general' as const, title, agent: 'claude', chip: 'CL', working: false, last_at: '2026-08-24T09:00:00Z' });

  it('says what the place is, in the words the conversation was given', () => {
    expect(placeLines({ chat: chat('Checkout rework'), health: null, status: null }).said).toBe('Checkout rework');
  });

  it('says the same thing whether or not health has ever reported', () => {
    // The row must not go blank just because nothing is watching the project —
    // which was the whole bug.
    const quiet = placeLines({ chat: chat('Checkout rework'), health: null, status: null });
    const watched = placeLines({ chat: chat('Checkout rework'), health: 'Everything users touch is healthy.', status: 'healthy' });
    expect(watched.said).toBe(quiet.said);
    // And a calm health line never gets a line of its own: the edge already
    // says it, and spending a row on it pushes off what you were doing.
    expect(watched.note).toBeNull();
  });

  it('gives a needs-you sentence its own line, because colour alone is not actionable', () => {
    const line = placeLines({ chat: chat('Checkout rework'), health: 'Looks down right now.', status: 'needs' });
    expect(line.said).toBe('Checkout rework');
    expect(line.note).toBe('Looks down right now.');
  });

  it('never promotes working or cannot-tell to a sentence — that is what the edge is for', () => {
    expect(placeLines({ chat: chat('x'), health: 'Two branches in motion.', status: 'working' }).note).toBeNull();
    expect(placeLines({ chat: chat('x'), health: "I can't fully verify this.", status: 'unknown' }).note).toBeNull();
  });

  it('invites you in when nobody has said anything yet', () => {
    expect(placeLines({ chat: null, health: null, status: null }).said).toBe(NOTHING_SAID);
  });

  it('treats a blank or whitespace title as nothing said, rather than printing an empty line', () => {
    expect(placeLines({ chat: chat('   '), health: null, status: null }).said).toBe(NOTHING_SAID);
  });
});
