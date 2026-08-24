import { describe, it, expect } from 'vitest';
import { consoleLinks, type ConsoleLink } from '../../src/server/connectors/consoles.js';
import type { TopologySource } from '../../src/shared/types/pack.js';

/**
 * THE DOORS TO THE ACCOUNTS BEHIND A PROJECT.
 *
 * These URLs are the feature: a wrong one sends somebody to a 404 wearing
 * Selvedge's confidence, and a URL built differently on the phone than on the
 * web is two features pretending to be one. So the exact strings are pinned
 * here, once, where both clients read them from.
 */
describe('consoles — the doors to the accounts behind a project', () => {
  const pack = (...sources: Array<Partial<TopologySource> & { connector: TopologySource['connector']; resource_id: string }>) => ({
    topology: { sources: sources.map((s) => ({ role: 'source_of_truth' as const, ...s })) },
  });

  const urls = (links: ConsoleLink[]) => links.map((l) => l.url);

  it('railway goes straight to the variables tab, because secrets are the reason the link exists', () => {
    const links = consoleLinks(pack({ connector: 'railway', resource_id: 'proj_1/env_2/svc_3' }));
    expect(links).toEqual([
      {
        provider: 'Railway',
        label: 'variables & deploys',
        url: 'https://railway.com/project/proj_1/service/svc_3/variables?environmentId=env_2',
      },
    ]);
  });

  it('knows each provider’s console by its stored id', () => {
    expect(urls(consoleLinks(pack({ connector: 'github', resource_id: 'acme/loom' })))).toEqual(['https://github.com/acme/loom']);
    expect(urls(consoleLinks(pack({ connector: 'neon', resource_id: 'shiny-water-123' })))).toEqual([
      'https://console.neon.tech/app/projects/shiny-water-123',
    ]);
    expect(urls(consoleLinks(pack({ connector: 'supabase', resource_id: 'abcdefghij' })))).toEqual([
      'https://supabase.com/dashboard/project/abcdefghij',
    ]);
  });

  it('orders by where a person actually reaches: runtime, database, then the repo', () => {
    const links = consoleLinks(
      pack(
        { connector: 'github', resource_id: 'acme/loom' },
        { connector: 'neon', resource_id: 'db-1' },
        { connector: 'railway', resource_id: 'p/e/s' },
      ),
    );
    expect(links.map((l) => l.provider)).toEqual(['Railway', 'Neon', 'GitHub']);
  });

  /**
   * A malformed id yields NO link, never a broken one. A link that 404s
   * teaches the owner the feature lies; a missing link says only that
   * Selvedge doesn't know that console, which is true.
   */
  it('refuses to build a door from a broken id', () => {
    expect(
      consoleLinks(
        pack(
          { connector: 'railway', resource_id: 'only-one-part' },
          { connector: 'github', resource_id: 'no-slash' },
          { connector: 'github', resource_id: 'too/many/parts' },
          { connector: 'neon', resource_id: '  ' },
          { connector: 'neon', resource_id: 'has space' },
          { connector: 'supabase', resource_id: 'ref?injection=1' },
        ),
      ),
    ).toEqual([]);
  });

  it('never emits a URL a resource id can escape from', () => {
    // Ids come from connector callbacks and imports — external data. An id
    // with a path traversal or a fragment must not survive into the URL raw.
    const [link] = consoleLinks(pack({ connector: 'neon', resource_id: 'a%2F..%2Fadmin' }));
    expect(link!.url).toBe('https://console.neon.tech/app/projects/a%252F..%252Fadmin');
  });

  it('one door per console, however many roles the source plays', () => {
    const links = consoleLinks(
      pack(
        { connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' },
        { connector: 'github', resource_id: 'acme/loom', role: 'auxiliary' },
      ),
    );
    expect(links).toHaveLength(1);
  });

  it('unknown connectors contribute nothing — vercel waits for a stored dashboard URL', () => {
    expect(consoleLinks(pack({ connector: 'vercel', resource_id: 'prj_123' }))).toEqual([]);
    expect(consoleLinks(pack({ connector: 'custom', resource_id: 'whatever' }))).toEqual([]);
  });

  it('a pack with no sources has no doors, not an error', () => {
    expect(consoleLinks({ topology: { sources: [] } })).toEqual([]);
  });
});
