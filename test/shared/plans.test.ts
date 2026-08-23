import { describe, it, expect } from 'vitest';
import {
  BYO_KEYS_LINE,
  FOUNDING_MEMBER_BADGE,
  PLANS,
  SHIPPED_PLANS,
  UPGRADE_PROMPTS,
  buildMinutesLine,
  historyLine,
  isPlanId,
  planBullets,
  planLimits,
  priceLine,
  projectsLine,
  yearlySavingLine,
} from '../../src/shared/plans.js';

/**
 * THE DRIFT GUARD.
 *
 * The bug this file exists to prevent is a pricing page that says "60 build
 * minutes" while the server allows 30. Nobody writes that on purpose; it
 * arrives when the number lives in two files and one gets edited. So every
 * sentence with a number in it is GENERATED from the limits the entitlements
 * module reads, and these tests hold that generation rather than the current
 * prices — a price change should not have to be typed twice, here included.
 */
describe('the plan table', () => {
  const free = planLimits('free');
  const pro = planLimits('pro');

  it('sells what it says it sells, and no more', () => {
    expect(SHIPPED_PLANS.map((p) => p.id)).toEqual(['free', 'pro']);
    // Team is in the table so the column and the type know about it. A plan you
    // can reach but not use is worse than one you cannot see.
    expect(planLimits('team').shipped).toBe(false);
    expect(PLANS.map((p) => p.id)).toContain('team');
  });

  it('only recognises the ids it stores', () => {
    expect(isPlanId('pro')).toBe(true);
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
  });

  /**
   * The property, not the price: every number the cards show comes from the
   * limits. Changing a limit changes the page in the same commit, or it doesn't
   * change at all.
   */
  it('writes its own copy from its own limits', () => {
    expect(projectsLine('free')).toContain(String(free.projects));
    expect(historyLine('free')).toContain(String(free.historyDays));
    expect(buildMinutesLine('free')).toContain(String(free.buildMinutes));
    expect(buildMinutesLine('pro')).toContain(String(pro.buildMinutes));
    expect(priceLine('pro')).toContain(String(pro.priceUsd.monthly));
    expect(priceLine('pro', 'yearly')).toContain(String(pro.priceUsd.yearly));
  });

  it('says unlimited as a word rather than as a number nobody can read', () => {
    expect(projectsLine('pro')).toMatch(/unlimited/i);
    expect(historyLine('pro')).toMatch(/full history/i);
    expect(projectsLine('pro')).not.toMatch(/\d/);
  });

  it('reads $0 as free rather than as a price of zero', () => {
    expect(priceLine('free')).toBe('$0');
  });

  it('prices a seat plan per seat', () => {
    expect(priceLine('team')).toMatch(/seat/);
  });

  /**
   * "2 months free" is a thing a person can check against the two prices on the
   * page. "20% off" is a thing they have to trust. So the saving is computed,
   * in whole months, from the two numbers actually being charged.
   */
  it('works out the yearly saving from the two prices, in months', () => {
    const line = yearlySavingLine('pro')!;
    const months = Math.floor((pro.priceUsd.monthly * 12 - pro.priceUsd.yearly!) / pro.priceUsd.monthly);
    expect(line).toBe(`${months} month${months === 1 ? '' : 's'} free`);
    // Nothing to claim where there is no yearly price.
    expect(yearlySavingLine('free')).toBeNull();
    expect(yearlySavingLine('team')).toBeNull();
  });

  it('gives each card a list that ends somewhere a person can stop reading', () => {
    expect(planBullets('free')).toContain('Full export, always');
    expect(planBullets('pro')).toContain('Everything in Free');
    expect(planBullets('pro')).toContain('Decision briefs');
    expect(planBullets('free')).not.toContain('Decision briefs');
  });

  /**
   * The three sentences an owner meets at a wall. Each one carries the price,
   * because a limit that doesn't say what lifts it is just a closed door.
   */
  it('puts the price in every refusal', () => {
    for (const prompt of Object.values(UPGRADE_PROMPTS)) {
      expect(prompt).toContain(priceLine('pro'));
    }
  });

  it('says the history lock is a lock and not a deletion', () => {
    expect(UPGRADE_PROMPTS.history).toMatch(/never deleted/i);
  });

  /**
   * The differentiator, and the thing most likely to be mistaken for a catch.
   * It is said once, plainly, next to the prices — and it must never imply that
   * model usage is included, because it isn't.
   */
  it('says whose the model costs are, without promising unlimited anything', () => {
    expect(BYO_KEYS_LINE).toMatch(/your own AI keys or subscriptions/i);
    // Both ways of bringing your own, because both now work: the builders read
    // a subscription token and an API key from different variables and the
    // connect screen takes either (server/build/builderAuth.ts).
    expect(BYO_KEYS_LINE).toMatch(/every agent runs on your account/i);
    expect(BYO_KEYS_LINE).toMatch(/spend ceilings/i);
    expect(BYO_KEYS_LINE).toContain(priceLine('pro'));
    expect(BYO_KEYS_LINE.toLowerCase()).not.toContain('unlimited');
  });

  it('makes the founding-member promise a price rather than a countdown', () => {
    expect(FOUNDING_MEMBER_BADGE).toContain(priceLine('pro'));
    expect(FOUNDING_MEMBER_BADGE).toMatch(/forever/i);
    for (const hype of ['% off', 'limited time', 'hurry', 'ends']) {
      expect(FOUNDING_MEMBER_BADGE.toLowerCase()).not.toContain(hype);
    }
  });

  /** Import is the acquisition hook and it is free. It has never been a tier feature. */
  it('gives import and export away at every tier', () => {
    expect(planBullets('free').join(' ')).toMatch(/import your entire/i);
    expect(planBullets('free').join(' ')).toMatch(/export, always/i);
  });
});
