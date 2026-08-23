import { describe, it, expect, vi, afterEach } from 'vitest';
import { SKELETON_AFTER_MS, SLOW_AFTER_MS, SLOW_LINE } from '../../src/client/components/ui.js';

/**
 * WHEN A PANE SHOWS ITS SHAPE, AND WHEN IT ADMITS IT IS SLOW.
 *
 * The two thresholds are the whole design, and both are easy to get wrong in
 * the same direction — toward showing the skeleton more.
 *
 * A skeleton that appears and vanishes inside 150ms is not reassurance, it is
 * a flash of grey where the content was about to be: its own piece of jank,
 * caused by the thing meant to prevent jank. Most local responses land inside
 * that window, so under it the honest render is nothing at all.
 *
 * And a skeleton is a promise that something is arriving. Past a few seconds
 * that promise stops being credible and starts being a lie by omission, so the
 * pane says the true thing and keeps waiting rather than shimmering forever.
 */
describe('the loading thresholds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits before showing a shape, and is not a spinner', () => {
    // Not zero: at zero this is a flash. Not a second: at a second the page
    // has already been blank long enough to look broken.
    expect(SKELETON_AFTER_MS).toBe(150);
    expect(SKELETON_AFTER_MS).toBeGreaterThan(0);
    expect(SKELETON_AFTER_MS).toBeLessThan(400);
  });

  it('stops promising and starts explaining, well before a person gives up', () => {
    expect(SLOW_AFTER_MS).toBe(8_000);
    expect(SLOW_AFTER_MS).toBeGreaterThan(SKELETON_AFTER_MS * 10);
  });

  it('says it is still trying, rather than that it failed', () => {
    // The distinction that matters: this surface has NOT given up, and the
    // sentence must not read as though it had. "Still loading" and a reason.
    expect(SLOW_LINE).toMatch(/still loading/i);
    expect(SLOW_LINE).not.toMatch(/failed|error|couldn't|unable/i);
  });
});
