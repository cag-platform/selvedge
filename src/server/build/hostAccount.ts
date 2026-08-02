import type { Db } from '../db/client.js';
import { resolveRailwayToken } from '../connectors/railway/resolve.js';
import { platformHostToken } from '../connectors/railway/provision.js';

/**
 * Whose hosting account an app goes live on — and why it is theirs by default.
 *
 * THE CONSTRAINT (MIGRATION-CENTER §1): Railway's fair-use policy prohibits
 * "reselling compute resources" and Vercel's terms prohibit making the service
 * available to third parties. Hosting customers' apps inside Selvedge's own
 * Railway account is therefore not a pricing choice we get to make — it is a
 * contract violation at any real volume. The umbrellas that do exist in this
 * market (Lovable on Supabase, Replit on Neon) are negotiated commercial
 * partnerships, not team accounts.
 *
 * THE POSTURE: the product's whole pitch is that the customer can fire Selvedge
 * and everything keeps running. Customer-owned infrastructure, Selvedge-
 * orchestrated — the deed in their name, Selvedge holding the keys as
 * caretaker. An umbrella would just move the hostage.
 *
 * THE EASE-OF-USE ANSWER is not custody, it is CONSENT DESIGN: one "Login with
 * Railway" OAuth click rather than a token to find and paste, and a database
 * that can be provisioned with no signup at all and claimed afterwards. That
 * work is what makes this feel like one button; owning their account is not.
 *
 * SELVEDGE_MANAGED_HOSTING exists only for dogfooding Selvedge's OWN apps in
 * Selvedge's own account — which is not reselling. It defaults OFF, and it must
 * not be switched on to host customers.
 */

export type HostAccount = {
  token: string;
  /** Whose account this is — the owner is told, because it decides who gets the bill. */
  owner: 'customer' | 'selvedge';
};

export function managedHostingAllowed(): boolean {
  return process.env.SELVEDGE_MANAGED_HOSTING === '1';
}

export async function resolveHostAccount(db: Db, orgId: string): Promise<HostAccount | null> {
  const own = await resolveRailwayToken(db, orgId).catch(() => null);
  if (own) return { token: own, owner: 'customer' };
  if (!managedHostingAllowed()) return null;
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
