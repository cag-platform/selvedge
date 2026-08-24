import { describe, it, expect } from 'vitest';
import {
  withPreviewToken,
  tokenStillGood,
  nothingToPreviewLine,
  NothingToPreviewError,
  StartFailedError,
  type PreviewShape,
} from '../../src/server/build/preview.js';

describe('withPreviewToken — the signed URL handed to the iframe', () => {
  it('appends the token as the daytona preview param', () => {
    const url = withPreviewToken('https://3000-abc.proxy.daytona.work/', 'tok_1');
    expect(url).toBe('https://3000-abc.proxy.daytona.work/?x-daytona-preview-token=tok_1');
  });

  it('replaces an existing token rather than stacking a second one', () => {
    const url = withPreviewToken('https://3000-abc.proxy.daytona.work/?x-daytona-preview-token=old', 'new');
    expect(url).toContain('x-daytona-preview-token=new');
    expect(url).not.toContain('old');
  });
});

describe('tokenStillGood — re-mint before expiry, never serve a lapsing token', () => {
  const now = new Date('2026-08-01T12:00:00Z');

  it('a token with comfortable life left is reused', () => {
    expect(tokenStillGood('tok', new Date('2026-08-01T12:30:00Z'), now)).toBe(true);
  });

  it('a token inside the 5-minute refresh margin is NOT reused — a just-served URL must never lapse mid-load', () => {
    expect(tokenStillGood('tok', new Date('2026-08-01T12:04:00Z'), now)).toBe(false);
  });

  it('missing token or expiry is never good', () => {
    expect(tokenStillGood(null, new Date('2026-08-01T13:00:00Z'), now)).toBe(false);
    expect(tokenStillGood('tok', null, now)).toBe(false);
  });
});

/**
 * THE DIRECTORY LISTING THAT CALLED ITSELF AN APP.
 *
 * A repo with no `dev` script was handed to a static file server pointed at
 * its own source tree. For a built web app that is right. For an Xcode project
 * it produced `Index of app/` — .gitignore, README.md,
 * RegionalPancreas.xcodeproj — served on :3000, answering curl with a 200, and
 * reported as `ready` under "the app, live in the workshop". Every check
 * downstream agreed, because a file index is a working web page; it just isn't
 * anybody's app.
 *
 * The sentence is asserted here rather than the shell, because the shell needs
 * a sandbox and the sentence is the part a person reads.
 */
describe('nothing to preview — said plainly, and never dressed as the app', () => {
  it('names what it found, so the answer explains itself', () => {
    const line = nothingToPreviewLine('an Xcode project');
    expect(line).toContain('an Xcode project');
    expect(line).toMatch(/nothing here I can show in a browser/i);
    // Never phrased as a fault: a native app not opening in a browser is a
    // fact about the app, not a failure of it.
    expect(line).not.toMatch(/error|failed|sorry|couldn't start/i);
  });

  it('still says something useful when it cannot tell what the repo is', () => {
    const line = nothingToPreviewLine(null);
    expect(line).toMatch(/nothing here I can show in a browser/i);
    // Unknown is not silence: it says what it looked for, so the owner can
    // tell whether the answer is wrong.
    expect(line).toMatch(/dev server/i);
    expect(line).toMatch(/index\.html/i);
  });

  it('carries the repo shape rather than a boolean, so "no dev script" is not "serve the folder"', () => {
    // The type is the fix. A two-way answer forced everything that was not a
    // dev server into the static branch; a three-way one lets the third case
    // exist, which is the whole bug.
    const shapes: PreviewShape[] = [
      { kind: 'dev' },
      { kind: 'static', dir: 'dist' },
      { kind: 'none', what: 'an Xcode project' },
    ];
    expect(shapes.map((s) => s.kind).sort()).toEqual(['dev', 'none', 'static']);
  });

  it('is an answer, not an error — the state says so', () => {
    const err = new NothingToPreviewError('a Swift package');
    expect(err).toBeInstanceOf(Error);
    expect(err.what).toBe('a Swift package');
    // Distinguishable from a start failure, which is what routes the two to
    // different states and stops this one offering a database or an env box.
    expect(err instanceof StartFailedError).toBe(false);
  });
});
