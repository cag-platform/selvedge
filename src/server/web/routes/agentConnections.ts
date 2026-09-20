import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listConnected } from '../../connectors/credentials/store.js';
import { listAgentRuntimes } from '../../companion/agentRuntime.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

type ConnectionState = {
  connected: boolean;
  kind: 'subscription' | 'api_key' | 'local' | null;
  label: string | null;
  last4: string | null;
  machine: string | null;
};

/**
 * One small, provider-neutral read model for the Connections page.
 *
 * The credentials vault and the local companion deliberately remain separate
 * systems. This endpoint joins their display-only status without ever reading
 * a secret, so the UI can answer the useful question — "how can this agent
 * run?" — without teaching the browser about either storage mechanism.
 */
export function createAgentConnectionsRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/agent-connections',
    asyncHandler(async (req, res) => {
      const [credentials, runtimes] = await Promise.all([
        listConnected(db, orgIdOf(req)),
        listAgentRuntimes(db, orgIdOf(req)),
      ]);
      const credential = (provider: string, kind?: 'subscription' | 'api_key') =>
        credentials.find((row) => row.status === 'active' && row.provider === provider && (!kind || row.kind === kind)) ?? null;
      const localFor = (agent: 'codex' | 'claude-code') => runtimes.find((row) => {
        if (!row.online) return false;
        const capabilities = row.capabilities as { codex?: boolean; claudeCode?: boolean };
        return agent === 'codex' ? capabilities.codex === true : capabilities.claudeCode === true;
      }) ?? null;
      const localRuntimes = runtimes.filter((row) => row.online);
      const local = localRuntimes[0] ?? null;
      const state = (agent: 'codex' | 'claude-code'): ConnectionState => {
        const agentLocal = localFor(agent);
        const localReady = Boolean(agentLocal);
        const provider = agent === 'codex' ? 'openai' : 'anthropic';
        const subscription = credential(provider, 'subscription');
        const apiKey = credential(provider, 'api_key');
        if (localReady) {
          return { connected: true, kind: 'local', label: agentLocal?.name ?? null, last4: null, machine: agentLocal?.name ?? null };
        }
        const selected = subscription ?? apiKey;
        return {
          connected: Boolean(selected),
          kind: selected ? (selected.kind as 'subscription' | 'api_key') : null,
          label: selected?.label ?? null,
          last4: selected?.last4 ?? null,
          machine: null,
        };
      };
      // Gemini has no local bridge and no subscription path — an API key is
      // the whole story, so its state is the credential row and nothing else.
      const geminiKey = credential('gemini', 'api_key');
      const gemini: ConnectionState = {
        connected: Boolean(geminiKey),
        kind: geminiKey ? 'api_key' : null,
        label: geminiKey?.label ?? null,
        last4: geminiKey?.last4 ?? null,
        machine: null,
      };

      res.json({
        agents: {
          codex: state('codex'),
          claude_code: state('claude-code'),
          gemini,
        },
        local: local
          ? {
              connected: true,
              name: localRuntimes.map((row) => row.name).filter(Boolean).join(', '),
              codex: localRuntimes.some((row) => Boolean((row.capabilities as { codex?: boolean }).codex)),
              claude_code: localRuntimes.some((row) => Boolean((row.capabilities as { claudeCode?: boolean }).claudeCode)),
            }
          : { connected: false, name: null, codex: false, claude_code: false },
      });
    }),
  );

  return router;
}
