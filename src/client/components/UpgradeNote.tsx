import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import type { LimitCode } from '../../shared/plans.js';

/**
 * WHAT A PLAN LIMIT LOOKS LIKE WHEN YOU MEET ONE.
 *
 * One component, used at every friction point, for the same reason there is one
 * entitlements module on the server: three hand-written upgrade prompts become
 * three slightly different products, and the one that drifts is the one nobody
 * looks at.
 *
 * THREE RULES.
 *
 * 1. THE SERVER'S SENTENCE, NOT OURS. The message is whatever the route said,
 *    which comes from the shared plan table — so the number in it is the number
 *    being enforced. A client that composed its own copy here could tell
 *    somebody the limit was two while the server allowed three.
 *
 * 2. ONE LINE, NEVER A MODAL. Meeting a limit is a small moment in the middle
 *    of doing something else. A dialog stops the work to sell; a line says what
 *    happened and leaves the person in charge of what happens next.
 *
 * 3. NO RUST. `--thread` means "this needs you" and is rationed to that. A
 *    plan limit is not an incident, and colouring it like one would spend the
 *    product's loudest signal on a sales moment — which is exactly the thing
 *    that teaches people to stop trusting the colour.
 */

/** The typed limit this error is, or null when it is any other kind of failure. */
export function limitCodeOf(error: unknown): LimitCode | null {
  if (!(error instanceof ApiError) || error.status !== 402) return null;
  const code = error.body.code;
  return typeof code === 'string' ? (code as LimitCode) : null;
}

export function UpgradeNote({ error }: { error: unknown }) {
  const code = limitCodeOf(error);
  if (!code || !(error instanceof ApiError)) return null;

  return (
    <p className="mt-2 text-body text-ink-dim">
      {error.message}{' '}
      <Link
        to="/settings/billing"
        className="text-ink underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
      >
        See plans
      </Link>
    </p>
  );
}

/**
 * "142 older items — upgrade to see them."
 *
 * Shown wherever a list has been cut short by the history window, and shown
 * even when the visible part is empty. A window that silently returns fewer
 * rows is the same lie as a truncated list that does not say it truncated: it
 * teaches the owner their record does not contain something it does contain.
 */
export function LockedOlder({ count, note }: { count: number; note?: string | null }) {
  if (count <= 0) return null;
  return (
    <p className="mt-3 text-body text-ink-quiet">
      {count} older {count === 1 ? 'item' : 'items'} {count === 1 ? 'is' : 'are'} locked on this plan — locked, never
      deleted, and an export includes {count === 1 ? 'it' : 'them'} either way.{' '}
      <Link
        to="/settings/billing"
        className="text-ink underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
      >
        {note ? 'See plans' : 'Upgrade to see them'}
      </Link>
    </p>
  );
}
