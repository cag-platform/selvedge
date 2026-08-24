import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { readAppZip, MAX_FILES } from '../../src/server/import/replitApp.js';

/**
 * A Repl's zip is a WORKSPACE — the app plus node_modules, caches and
 * virtualenvs, usually mostly the latter. What these hold: the app comes
 * through whole, the junk is left behind BY NAME, and every cap refuses with
 * a sentence rather than trimming — 380 of 400 files is an app that almost
 * works, which is worse than a clear no.
 */
describe('reading a Repl out of its zip', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const zip = (files: Record<string, Uint8Array>) => zipSync(files);

  it('unwraps the single top folder Replit wraps the export in', () => {
    const read = readAppZip(zip({ 'my-repl/index.js': enc('code'), 'my-repl/src/app.js': enc('more') }));
    expect(read.ok && read.files.map((f) => f.path).sort()).toEqual(['index.js', 'src/app.js']);
  });

  it('leaves the workspace junk behind and names it', () => {
    const read = readAppZip(
      zip({
        'r/index.js': enc('code'),
        'r/node_modules/lodash/lodash.js': enc('x'.repeat(1000)),
        'r/.git/HEAD': enc('ref'),
        'r/__pycache__/a.pyc': enc('x'),
      }),
    );
    expect(read.ok && read.files.map((f) => f.path)).toEqual(['index.js']);
    expect(read.ok && read.skipped).toEqual(['.git', '__pycache__', 'node_modules']);
    expect(read.ok && read.skippedCount).toBe(3);
  });

  it('keeps dist — for a static site it IS the app', () => {
    const read = readAppZip(zip({ 'r/dist/index.html': enc('<html>'), 'r/dist/main.css': enc('body{}') }));
    expect(read.ok && read.files.map((f) => f.path).sort()).toEqual(['dist/index.html', 'dist/main.css']);
  });

  it('refuses a zip with escaping paths whole — those bytes go into a git tree', () => {
    const read = readAppZip(zip({ 'ok.js': enc('fine'), '../escape.sh': enc('nope') }));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain('refuse');
  });

  it('refuses over the file-count cap, naming the count', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_FILES + 1; i++) files[`r/f${i}.txt`] = enc('x');
    const read = readAppZip(zip(files));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain(String(MAX_FILES + 1));
  });

  it('refuses one oversized file by name, never trims it', () => {
    const read = readAppZip(zip({ 'r/app.js': enc('fine'), 'r/video.mp4': new Uint8Array(3 * 1024 * 1024) }));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain('video.mp4');
  });

  it('a zip that is all junk says so, not "success, zero files"', () => {
    const read = readAppZip(zip({ 'r/node_modules/a.js': enc('x') }));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain('no app');
  });

  it('not a zip at all is one plain sentence', () => {
    const read = readAppZip(enc('PK this is not really a zip'));
    expect(read.ok).toBe(false);
  });
});
