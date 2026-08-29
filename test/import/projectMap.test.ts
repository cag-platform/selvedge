import { describe, expect, it } from 'vitest';
import { inspectProjectFiles } from '../../src/server/import/projectMap.js';

const file = (path: string, body: string) => ({ path, bytes: new TextEncoder().encode(body) });

describe('migration project map', () => {
  it('reports observed dependencies and preserves unknowns as access needs', () => {
    const map = inspectProjectFiles([
      file('package.json', JSON.stringify({ dependencies: { next: '15', '@supabase/supabase-js': '2', stripe: '17' } })),
      file('src/auth.ts', "const key = process.env.SUPABASE_KEY; supabase.auth.getUser()"),
      file('vercel.json', '{}'),
    ], new Date('2026-08-28T00:00:00Z'));
    expect(map.stack).toContain('Next.js');
    expect(map.items.find((item) => item.kind === 'database')?.status).toBe('found');
    expect(map.items.find((item) => item.kind === 'auth')?.status).toBe('found');
    expect(map.items.find((item) => item.kind === 'secret')?.status).toBe('found');
    expect(map.items.find((item) => item.kind === 'storage')?.status).toBe('needs_access');
    expect(map.limitations).toContain('File inspection cannot read secrets held in the source platform vault.');
  });
});
