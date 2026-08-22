import { describe, it, expect } from 'vitest';
import { allThreads, matches, railOrder, railPlaces, whenShort, type ProjectRow, type SubjectRow } from '../../src/client/lib/inbox.js';

const project = (over: Partial<ProjectRow>): ProjectRow => ({
  id: 'p',
  name: 'P',
  status: 'healthy',
  health: 'fine',
  threads: [],
  ...over,
});

/**
 * The rail's rules, tested away from the browser: what order projects appear
 * in, and how a thread's date reads. The order matters because the rail is the
 * screen the health test is run against — a project that needs you must not be
 * below three that don't.
 */
describe('the rail', () => {
  it('puts what needs you first, then what is moving, then what it cannot see, then the quiet', () => {
    const ordered = railOrder([
      project({ id: 'a', name: 'Alpha', status: 'healthy' }),
      project({ id: 'b', name: 'Bravo', status: 'unknown' }),
      project({ id: 'c', name: 'Charlie', status: 'needs' }),
      project({ id: 'd', name: 'Delta', status: 'working' }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('breaks ties by name, so the rail never reshuffles under you', () => {
    const ordered = railOrder([project({ id: 'z', name: 'Zulu' }), project({ id: 'a', name: 'Alpha' })]);
    expect(ordered.map((p) => p.name)).toEqual(['Alpha', 'Zulu']);
  });

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
 * The two rules that survive the merge are both honesty rules, and both are
 * about what the rail may CLAIM: a place with no code gets no status (a status
 * on it would be a claim about nothing), and it never outranks a place that
 * has one (a thing that cannot break must not sit above a thing that is
 * broken).
 */
describe('the rail, as one list', () => {
  const subject = (over: Partial<SubjectRow>): SubjectRow => ({ id: 's', name: 'S', threads: [], ...over });

  it('says nothing about a place with no code, rather than saying it is fine', () => {
    const [place] = railPlaces([], [subject({ id: 'pricing', name: 'Pricing' })]);
    expect(place!.status).toBeNull();
    expect(place!.health).toBeNull();
    expect(place!.hasCode).toBe(false);
  });

  it('never lets a place that cannot break sit above one that is broken', () => {
    const places = railPlaces(
      [project({ id: 'loom', name: 'Loom', status: 'needs' }), project({ id: 'yoke', name: 'Yoke', status: 'healthy' })],
      [subject({ id: 'aaa', name: 'Aaa' })],
    );
    expect(places.map((p) => p.id)).toEqual(['loom', 'yoke', 'aaa']);
  });

  it('keeps the health ordering the stack is read by', () => {
    const places = railPlaces(
      [
        project({ id: 'a', name: 'Alpha', status: 'healthy' }),
        project({ id: 'b', name: 'Bravo', status: 'unknown' }),
        project({ id: 'c', name: 'Charlie', status: 'needs' }),
        project({ id: 'd', name: 'Delta', status: 'working' }),
      ],
      [],
    );
    expect(places.map((p) => p.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('breaks ties by name among the code-less too, so nothing reshuffles under you', () => {
    const places = railPlaces([], [subject({ id: 'z', name: 'Zulu' }), subject({ id: 'a', name: 'Alpha' })]);
    expect(places.map((p) => p.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('carries every conversation through the merge — nothing is dropped by being re-sorted', () => {
    const places = railPlaces(
      [project({ id: 'loom', name: 'Loom', threads: [{ id: 't1' } as never] })],
      [subject({ id: 'pricing', name: 'Pricing', threads: [{ id: 't2' } as never, { id: 't3' } as never] })],
    );
    expect(places.flatMap((p) => p.threads).map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});
