import type { Db } from '../db/client.js';
import { DbNarrationLibrary } from '../narration/library.js';
import type { NarrationDeps } from '../narration/dispatch.js';
import type { ComposeLlmDeps } from '../digest/composeLlm.js';
import type { AskDeps } from '../ask/answer.js';
import type { SketchDeps } from '../sketch/converse.js';
import { resolveFuel } from '../connectors/fuel/resolve.js';

/**
 * The voice is powered per-org, at the moment of use, by that org's fuel
 * (§25.3). This is the pivot from "Selvedge pays for one model" to "each
 * customer's own key powers their own work."
 *
 * Every builder resolves the org's fuel (BYO → managed platform key → off).
 * No fuel → undefined deps → the deterministic path, exactly the shape the
 * consumers already handle when the voice is off. So "voice on/off" is now a
 * per-org fact, not a global env check: a BYO org has a voice; an org with no
 * fuel and no platform key does not, and its brief is mechanical.
 *
 * These are async and org-scoped by necessity — resolution is a DB lookup and
 * a decryption. Call them at the entry point that knows the org (per event in
 * ingest, per request in a route, per org in the digest loop), never once at
 * startup.
 */

export async function buildNarrationDeps(db: Db, orgId: string): Promise<NarrationDeps | undefined> {
  const fuel = await resolveFuel(db, orgId);
  if (!fuel) return undefined;
  return { llm: fuel.client, db, library: new DbNarrationLibrary(db) };
}

export async function buildComposeDeps(db: Db, orgId: string): Promise<ComposeLlmDeps | undefined> {
  const fuel = await resolveFuel(db, orgId);
  if (!fuel) return undefined;
  return { llm: fuel.client, db };
}

export async function buildAskDeps(db: Db, orgId: string): Promise<AskDeps | undefined> {
  const fuel = await resolveFuel(db, orgId);
  if (!fuel) return undefined;
  return { llm: fuel.client, db };
}

export async function buildSketchDeps(db: Db, orgId: string): Promise<SketchDeps | undefined> {
  const fuel = await resolveFuel(db, orgId);
  if (!fuel) return undefined;
  return { llm: fuel.client, db };
}

/** The resolver shape the routes and the digest loop hold, so they build deps per-org at use time. */
export type ComposeDepsResolver = (orgId: string) => Promise<ComposeLlmDeps | undefined>;
export type AskDepsResolver = (orgId: string) => Promise<AskDeps | undefined>;
export type SketchDepsResolver = (orgId: string) => Promise<SketchDeps | undefined>;
