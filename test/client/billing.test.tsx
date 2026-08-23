import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LockedOlder, UpgradeNote, limitCodeOf } from '../../src/client/components/UpgradeNote.js';
import { ApiError } from '../../src/client/lib/api.js';
import { priceLine } from '../../src/shared/plans.js';

const render = (node: React.ReactElement): string => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

afterEach(() => vi.restoreAllMocks());

/**
 * WHAT A PLAN LIMIT LOOKS LIKE WHEN YOU MEET ONE.
 *
 * The property worth holding is not the wording — it is that the sentence the
 * owner reads is the SERVER'S sentence. A client that composed its own copy
 * here could tell somebody the limit was two while the server allowed three,
 * and nobody would find out from the code.
 */
describe('the upgrade prompt', () => {
  const limit = (code: string, message: string) => new ApiError(message, 402, { code });

  it('recognises a plan limit and nothing else', () => {
    expect(limitCodeOf(limit('limit_projects', 'x'))).toBe('limit_projects');
    // A 402 is the only status that means "you may, and here is what it takes".
    expect(limitCodeOf(new ApiError('x', 403, { code: 'limit_projects' }))).toBeNull();
    expect(limitCodeOf(new ApiError('x', 500, {}))).toBeNull();
    expect(limitCodeOf(new Error('plain'))).toBeNull();
    expect(limitCodeOf(null)).toBeNull();
  });

  it('shows the server’s sentence rather than one of its own', () => {
    const html = render(<UpgradeNote error={limit('limit_projects', `2 projects on Free. ${priceLine('pro')} lifts the limit.`)} />);
    expect(html).toContain('2 projects on Free');
    expect(html).toContain(priceLine('pro'));
    expect(html).toContain('/settings/billing');
  });

  it('renders nothing at all for a failure that is not a limit', () => {
    expect(render(<UpgradeNote error={new ApiError('the server fell over', 500, {})} />)).toBe('');
    expect(render(<UpgradeNote error={null} />)).toBe('');
  });

  /**
   * `--thread` means "this needs you" and is rationed to that. A plan limit is
   * not an incident, and colouring it like one is how a colour system stops
   * meaning anything.
   */
  it('never borrows the needs-you colour to sell something', () => {
    const html = render(<UpgradeNote error={limit('limit_history', 'Older history is locked on Free.')} />);
    expect(html).not.toContain('thread');
  });

  it('is one line, not a dialog', () => {
    const html = render(<UpgradeNote error={limit('limit_decision_briefs', 'Decision briefs are part of Pro.')} />);
    expect(html).not.toContain('role="dialog"');
    expect(html.startsWith('<p')).toBe(true);
  });
});

/**
 * A window that silently returns fewer rows is the same lie as a truncated list
 * that does not say it truncated: it teaches the owner their record does not
 * contain something it does contain.
 */
describe('the locked-history line', () => {
  it('says how many, and that they are locked rather than gone', () => {
    const html = render(<LockedOlder count={142} />);
    expect(html).toContain('142');
    expect(html).toMatch(/never\s*deleted/);
    expect(html).toMatch(/export/i);
    expect(html).toContain('/settings/billing');
  });

  it('counts one thing as one thing', () => {
    const html = render(<LockedOlder count={1} />);
    expect(html).toContain('1 older item');
    expect(html).not.toContain('items');
  });

  /** Nothing locked is nothing said. An upgrade prompt with no cause is an advert. */
  it('is silent when nothing is being held back', () => {
    expect(render(<LockedOlder count={0} />)).toBe('');
    expect(render(<LockedOlder count={-3} />)).toBe('');
  });
});
