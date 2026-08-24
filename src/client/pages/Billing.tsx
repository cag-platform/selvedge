import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Pane, btnPrimary, btnGhost, eyebrowCls } from '../components/ui.js';
import { BYO_KEYS_LINE, FOUNDING_MEMBER_BADGE, planBullets, priceLine, yearlySavingLine } from '../../shared/plans.js';

/**
 * WHAT YOU ARE ON, WHAT YOU HAVE USED, AND WHAT IT COSTS.
 *
 * One screen, and deliberately a plain one. Everything that touches a card
 * happens on Stripe's own pages, reached through a link this page asks the
 * server for — so there is no form here, no card field, and nowhere for a card
 * number to go.
 *
 * TWO THINGS THIS PAGE MUST NOT DO.
 *
 * It must not show a plan the server would not honour. Every number here comes
 * from `/api/billing`, which answers from the entitlements module — so what is
 * on this screen is what the gates actually do. A page that read the
 * subscription row directly would tell somebody they were on Pro for a week
 * after the grace period ended.
 *
 * And it must not bury the money. The build-minute bar is the same number the
 * meter records, not a friendlier version of it, and a failed payment is said
 * plainly at the top rather than as a quiet badge.
 */

type BuildMinutes = { used: number; limit: number; remaining: number };

type BillingState = {
  plan: 'free' | 'pro' | 'team';
  plan_name: string;
  status: 'active' | 'past_due' | 'canceled';
  billing_interval: 'monthly' | 'yearly' | null;
  current_period_end: string | null;
  grandfathered_price: boolean;
  needs_attention: boolean;
  build_minutes: BuildMinutes;
  projects: { used: number; limit: number | null };
  history_days: number | null;
  plans: Array<{ id: string; name: string; monthly: string; yearly: string | null }>;
  can_checkout: boolean;
};

function theDay(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function Billing() {
  const [state, setState] = useState<BillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<BillingState>('/api/billing')
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  /**
   * Both buttons do the same thing: ask the server for a Stripe URL and go
   * there. Neither knows anything about prices or cards — that is the whole
   * point of them being links rather than forms.
   */
  const go = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(path, body ?? {});
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (error && !state) return <p className="text-body text-thread">{error}</p>;
  if (!state) return <p className="text-body text-ink-quiet">Loading…</p>;

  const renews = theDay(state.current_period_end);
  const onFree = state.plan === 'free';

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Billing</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">{BYO_KEYS_LINE}</p>
      </div>

      {/*
        A failed payment, said at the top and in words. Rust is the product's
        rationed "this needs you" colour and a card that stopped working is
        exactly that: nothing is lost, nothing is locked yet, and it will be if
        nobody acts.
      */}
      {state.needs_attention && (
        <Pane className="border-thread">
          <p className="text-body text-ink">
            Your last payment didn’t go through. Everything still works for now — update your card and nothing changes.
          </p>
          <button className={`${btnPrimary} mt-3`} disabled={busy} onClick={() => void go('/api/billing/portal')}>
            Update card
          </button>
        </Pane>
      )}

      <Pane>
        <p className={eyebrowCls}>Your plan</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-display font-display font-medium text-ink">{state.plan_name}</span>
          <span className="text-body text-ink-dim">
            {onFree ? 'free, with no clock on it' : priceLine(state.plan, state.billing_interval ?? 'monthly')}
          </span>
        </div>

        {state.grandfathered_price && !onFree && <p className="mt-2 text-body text-ink-dim">{FOUNDING_MEMBER_BADGE}</p>}

        {/*
          Cancelled says WHEN, not just that. "Cancelled" on its own reads as
          "it stopped", and it hasn't — the period that was paid for runs out
          on a date, and that date is the useful half of the sentence.
        */}
        {state.status === 'canceled' && renews && (
          <p className="mt-2 text-body text-ink-dim">Cancelled — Pro stays on until {renews}, then this account goes back to Free. Nothing is deleted.</p>
        )}
        {state.status === 'active' && renews && !onFree && <p className="mt-2 text-body text-ink-dim">Renews {renews}.</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {onFree ? (
            <>
              <button className={btnPrimary} disabled={busy || !state.can_checkout} onClick={() => void go('/api/billing/checkout', { interval: 'monthly' })}>
                Go Pro — {priceLine('pro')}
              </button>
              <button className={btnGhost} disabled={busy || !state.can_checkout} onClick={() => void go('/api/billing/checkout', { interval: 'yearly' })}>
                or {priceLine('pro', 'yearly')}
                {yearlySavingLine('pro') ? ` (${yearlySavingLine('pro')})` : ''}
              </button>
            </>
          ) : (
            // Disabled when there is no payment processor: the portal is
            // Stripe's, and a primary button that can only fail is worse than
            // one that is plainly unavailable.
            <button className={btnPrimary} disabled={busy || !state.can_checkout} onClick={() => void go('/api/billing/portal')}>
              Manage billing
            </button>
          )}
        </div>
        {/*
          WHAT IS TRUE HERE DEPENDS ON THE PLAN, and this used to say the same
          thing either way: "everything runs on the Free tier". For an account
          on Pro with no processor configured — which is exactly what a
          hand-written subscription row looks like — that sat directly beneath
          "Your plan · $12/month · renews on the 23rd" and contradicted it.
          Two sentences in one panel disagreeing about what somebody is paying
          is the plainest kind of lie this product can tell.
        */}
        {!state.can_checkout && (
          <p className="mt-3 text-body text-ink-quiet">
            {onFree
              ? 'This deployment isn’t set up to take payments, so there is no way to upgrade from here. Nothing is charged.'
              : `Your account is on ${state.plan_name} and everything on it works. This deployment isn’t set up to take payments, though, so there is no card attached and nothing is being charged — and nothing here can change that.`}
          </p>
        )}
        {error && <p className="mt-3 text-body text-thread">{error}</p>}
      </Pane>

      <Pane>
        <p className={eyebrowCls}>This month</p>
        <BuildMinuteBar minutes={state.build_minutes} />
        <dl className="mt-4 space-y-1 text-body text-ink-dim">
          <div className="flex justify-between gap-4">
            <dt>Projects</dt>
            <dd className="text-ink">
              {state.projects.used}
              {state.projects.limit === null ? '' : ` of ${state.projects.limit}`}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>History you can see</dt>
            <dd className="text-ink">{state.history_days === null ? 'All of it' : `Last ${state.history_days} days`}</dd>
          </div>
        </dl>
        {state.history_days !== null && (
          <p className="mt-3 text-body text-ink-quiet">
            Older history is locked, never deleted. It comes back the moment you upgrade, and an export includes all of
            it either way.
          </p>
        )}
      </Pane>

      {onFree && (
        <Pane>
          <p className={eyebrowCls}>What Pro adds</p>
          <ul className="mt-2 space-y-1 text-body text-ink-dim">
            {planBullets('pro')
              .filter((line) => line !== 'Everything in Free')
              .map((line) => (
                <li key={line}>{line}</li>
              ))}
          </ul>
        </Pane>
      )}
    </div>
  );
}

/**
 * The meter, shown as the number it is.
 *
 * Over the limit is possible and is shown as over rather than pinned at full: a
 * run that starts with minutes left is allowed to finish, so the honest reading
 * of a month where that happened is "62 of 60", not a bar that quietly stops at
 * the end and implies nothing unusual occurred.
 */
function BuildMinuteBar({ minutes }: { minutes: BuildMinutes }) {
  const over = minutes.used > minutes.limit;
  const pct = Math.min(100, Math.round((minutes.used / Math.max(1, minutes.limit)) * 100));

  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-body text-ink-dim">Build minutes</span>
        <span className="text-body text-ink">
          {minutes.used} of {minutes.limit}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-inset bg-panel-soft"
        role="progressbar"
        aria-valuenow={minutes.used}
        aria-valuemin={0}
        aria-valuemax={minutes.limit}
        aria-label="Build minutes used this month"
      >
        {/* Rust only when it is genuinely "this needs you" — i.e. spent. */}
        <div className={`h-full ${over || minutes.remaining === 0 ? 'bg-thread' : 'bg-action'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-body text-ink-quiet">
        {over
          ? `That’s ${minutes.used - minutes.limit} over — a build that starts with minutes left is always allowed to finish. New builds wait for next month.`
          : minutes.remaining === 0
            ? 'None left this month. New builds wait for next month, and nothing is charged for going over.'
            : `${minutes.remaining} left. Time your sandboxes spend building and previewing — previews sleep after 10 idle minutes.`}
      </p>
    </div>
  );
}
