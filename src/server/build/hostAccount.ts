import type { Db } from '../db/client.js';
import { resolveRailwayToken } from '../connectors/railway/resolve.js';
import { platformHostToken } from '../connectors/railway/provision.js';

/**
 * Whose hosting account an app goes live on.
 *
 * This mirrors the rule the product already uses for model keys (fuel:
 * customer's own → Selvedge's → off), and for the same reason. Someone
 * arriving from Replit with infrastructure they already pay for should be able
 * to keep it and have Selvedge drive it. Someone arriving with nothing should
 * press one button and be online.
 *
 * The order matters and so does what it is NOT: connecting an account is an
 * OPTION, never a step. Nobody is ever asked for a token before their first
 * app goes live — if they have not brought one, Selvedge hosts it, and that is
 * the default path through the product.
 */

export type HostAccount = {
  token: string;
  /** Whose account this is — the owner is told, because it decides who gets the bill. */
  owner: 'customer' | 'selvedge';
};

export async function resolveHostAccount(db: Db, orgId: string): Promise<HostAccount | null> {
  const own = await resolveRailwayToken(db, orgId).catch(() => null);
  if (own) return { token: own, owner: 'customer' };
  const platform = platformHostToken();
  return platform ? { token: platform, owner: 'selvedge' } : null;
}

/** Where new services land, which differs by whose account it is. */
export function hostProjectOptions(account: HostAccount): { pinnedProjectId?: string | null; anyProject?: boolean } {
  return account.owner === 'selvedge'
    ? { pinnedProjectId: process.env.RAILWAY_PROJECT_ID ?? null }
    : { anyProject: true };
}

/** One clause for the owner about where their app now lives. */
export function whereItLives(account: HostAccount): string {
  return account.owner === 'customer' ? 'on your own Railway account' : "on Selvedge's hosting";
}
