import { describe, expect, it } from 'vitest';
import { contextStartsOpen } from '../../src/client/pages/Inbox.js';

describe('workbench presentation', () => {
  it('keeps Simple focused on the conversation at every desktop width', () => {
    expect(contextStartsOpen('simple', 1440)).toBe(false);
    expect(contextStartsOpen('simple', 1920)).toBe(false);
  });

  it('opens the complete builder beside a Full conversation on a wide screen', () => {
    expect(contextStartsOpen('full', 1280)).toBe(true);
    expect(contextStartsOpen('full', 1440)).toBe(true);
  });

  it('keeps Full usable as a drill-down on narrow screens', () => {
    expect(contextStartsOpen('full', 1279)).toBe(false);
    expect(contextStartsOpen('full', 768)).toBe(false);
  });
});
