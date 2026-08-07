import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { connectCredential, listConnected, revokeCredential } from '../../connectors/credentials/store.js';
import { vaultConfigured } from '../../connectors/credentials/crypto.js';
import { HOST_CREDENTIAL_PROVIDERS, type HostProvider as RegistryHostProvider } from '../../connectors/registry.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The host connectors' HTTP surface — where the owner grants Selvedge a token
 * to watch their deploys. This is what the Railway deploy poller's token
 * discovery reads; without it, that path was unreachable from the app.
 *
 * A host is the customer's or nothing (MIGRATION-CENTER §1): the token is stored
 * in the same write-only vault as fuel, org-scoped, shown back only as its last
 * four and a status, and revocable. Unlike fuel, we do NOT block on a live
 * verification here — a host we can't read degrades to "can't tell" everywhere
 * downstream (never a false event), so an unverified token is safe to store, and
 * the connectors-health surface reports whether it's actually working.
 */

const HOST_PROVIDERS = HOST_CREDENTIAL_PROVIDERS;
type HostProvider = RegistryHostProvider;

function isHostProvider(v: unknown): v is HostProvider {
  return typeof v === 'string' && (HOST_PROVIDERS as readonly string[]).includes(v);
}

export function createHostsRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/hosts',
    asyncHandler(async (req, res) => {
      const all = await listConnected(db, orgIdOf(req));
      const hosts = all.filter((c) => (HOST_PROVIDERS as readonly string[]).includes(c.provider));
      res.json({ connected: hosts, available: HOST_PROVIDERS });
    }),
  );

  router.post(
    '/api/hosts',
    asyncHandler(async (req, res) => {
      if (!vaultConfigured()) {
        res.status(503).json({ error: "I can't store keys yet — the server's credential vault isn't configured (CREDENTIALS_KEY needs to be set in the deploy, at least 32 characters). Nothing was saved." });
        return;
      }
      const { provider, token, label } = req.body as { provider?: unknown; token?: unknown; label?: unknown };
      if (!isHostProvider(provider)) {
        res.status(400).json({ error: 'provide a supported host' });
        return;
      }
      if (typeof token !== 'string' || token.trim().length < 8 || token.length > 500) {
        res.status(400).json({ error: 'provide a token' });
        return;
      }
      // A credential row is keyed on (org, provider) and the write is an
      // unconditional upsert, so pasting a token here would overwrite a
      // one-click sign-in — silently swapping a refreshable token SET for a
      // bare string that expires in an hour and cannot renew itself. Refuse,
      // and say which connection is already in place.
      const existing = (await listConnected(db, orgIdOf(req))).find((c) => c.provider === provider);
      if (existing?.kind === 'subscription') {
        res.status(409).json({
          error: `You're already signed in to ${provider} with one click${existing.label ? ` (${existing.label})` : ''}. Disconnect that first if you'd rather use a pasted token — otherwise pasting one here would replace a connection that renews itself with one that expires.`,
        });
        return;
      }

      const cleanLabel = typeof label === 'string' && label.length <= 80 ? label : undefined;
      const saved = await connectCredential(db, orgIdOf(req), provider, token.trim(), {
        kind: 'api_key',
        ...(cleanLabel ? { label: cleanLabel } : {}),
      });
      res.json({ connected: saved });
    }),
  );

  router.delete(
    '/api/hosts/:provider',
    asyncHandler(async (req, res) => {
      const provider = req.params.provider ?? '';
      if (!isHostProvider(provider)) {
        res.status(400).json({ error: 'unknown host' });
        return;
      }
      const removed = await revokeCredential(db, orgIdOf(req), provider);
      res.json({ removed });
    }),
  );

  return router;
}
