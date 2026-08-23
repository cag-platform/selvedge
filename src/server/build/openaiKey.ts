import type { Db } from '../db/client.js';
import { useCredential } from '../connectors/credentials/store.js';

/**
 * THE KEY CODEX BUILDS WITH.
 *
 * Same shape of bug as repoToken.ts, in a different corner: one job, two
 * identities. Ask GPT a question in a thread and it runs on the OpenAI key
 * YOUR workspace connected, resolved through the fuel seam — bring your own
 * key, that's the whole model. Ask Codex to build something and it ran on
 * `process.env.OPENAI_API_KEY`, the platform's key, and nothing else.
 *
 * So "connect your OpenAI key" meant one thing on one surface and something
 * else on the other. An owner with a perfectly good connected key got a 401
 * from a sandbox they had already been charged a minute for, and the fix was
 * to go and put a second copy of a key into a deployment they don't own.
 *
 * One resolution order now, matching resolveFuelFor: the org's own credential
 * first, the platform key as the fallback, and nothing when there is neither.
 * BYO before managed before off.
 *
 * WHY NOT resolveFuelFor ITSELF. That returns a live LlmClient — a thing that
 * makes model calls from this process. Codex needs the raw secret to hand to a
 * CLI inside a sandbox. Same order, same store, different end of the wire.
 */

export type OpenAiKeyDeps = {
  /** The platform's own key, for a deployment running managed fuel. */
  platformKey?: () => string | undefined;
};

/**
 * The OpenAI secret this org should build with, or null when it has none and
 * the platform can't cover it. Null is an answer, not a failure: the roster
 * says plainly that Codex isn't available and offers the fix.
 */
export async function resolveOpenAiKey(db: Db, orgId: string, deps: OpenAiKeyDeps = {}): Promise<string | null> {
  const connected = await useCredential(db, orgId, 'openai').catch(() => null);
  if (connected?.trim()) return connected.trim();
  const platform = (deps.platformKey ?? (() => process.env.OPENAI_API_KEY))()?.trim();
  return platform || null;
}
