import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@daytonaio/sdk';
import { maintainSandboxArchives } from '../../src/server/build/reaper.js';

describe('sandbox archive maintenance', () => {
  it('archives only old stopped Selvedge sandboxes and never deletes them', async () => {
    const events: string[] = [];
    const sandbox = (id: string, state: string, lastActivityAt: string, labels: Record<string, string>) => ({
      id, state, lastActivityAt, labels,
      setAutoArchiveInterval: async (minutes: number) => void events.push(`policy:${id}:${minutes}`),
      archive: async () => void events.push(`archive:${id}`),
    }) as unknown as Sandbox;
    const rows = [
      sandbox('old', 'stopped', '2026-08-26T10:00:00Z', { 'selvedge/org': 'o', 'selvedge/project': 'p' }),
      sandbox('recent', 'stopped', '2026-08-26T11:45:00Z', { 'selvedge/org': 'o', 'selvedge/project': 'q' }),
      sandbox('running', 'started', '2026-08-26T10:00:00Z', { 'selvedge/org': 'o', 'selvedge/project': 'r' }),
      sandbox('foreign', 'stopped', '2026-08-26T10:00:00Z', {}),
    ];
    const out = await maintainSandboxArchives(new Date('2026-08-26T12:00:00Z'), {
      list: async function* () { yield* rows; },
    });
    expect(out).toEqual({ policyApplied: ['old', 'recent', 'running'], archived: ['old'] });
    expect(events).toEqual(['policy:old:60', 'archive:old', 'policy:recent:60', 'policy:running:60']);
    expect(events.some((event) => event.includes('delete'))).toBe(false);
  });
});
