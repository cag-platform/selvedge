import { Router, type Request } from 'express';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { agentMessages, agentRuns } from '../../db/schema/index.js';
import { getBuild } from '../../build/store.js';
import { runAgentTurn, type AgentTurnConfig } from '../../build/agent.js';
import { ensurePreview, type PreviewStatus } from '../../build/preview.js';
import { stopSandbox, type SandboxConfig } from '../../build/sandbox.js';
import { shipChanges, rollbackShip } from '../../build/ship.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The workshop's HTTP surface — chat with the agent, watch the runs, see the
 * preview, and (cost-watch) stop the sandbox explicitly. Org-scoped throughout;
 * plain-English about every state it can't serve: no project, engine not
 * configured, already working.
 *
 * A turn takes minutes, so POST /message starts it in the background (202) and
 * the page polls the workshop state; the thread and run row update as it works.
 * One turn per project at a time — the agent finishing one thing before starting
 * the next is a feature, not a limitation.
 */

/** A run this old still marked running is a crashed process, not real work — it must not block forever. */
const STUCK_RUN_MS = 45 * 60 * 1000;

function engineEnv(): { claudeCodeOauthToken: string; githubToken: string } | null {
  const claude = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const github = process.env.GITHUB_TOKEN?.trim();
  const daytona = process.env.DAYTONA_API_KEY?.trim();
  if (!claude || !github || !daytona) return null;
  return { claudeCodeOauthToken: claude, githubToken: github };
}

export type WorkshopDeps = {
  /** Injected for tests; defaults to the real agent turn. */
  runTurn?: typeof runAgentTurn;
  preview?: (db: Db, orgId: string, projectId: string, cfg: SandboxConfig) => Promise<PreviewStatus>;
  env?: () => { claudeCodeOauthToken: string; githubToken: string } | null;
};

export function createWorkshopRouter(db: Db, deps: WorkshopDeps = {}) {
  const router = Router();
  const runTurn = deps.runTurn ?? runAgentTurn;
  const preview = deps.preview ?? ensurePreview;
  const env = deps.env ?? engineEnv;

  /** The pack's GitHub source + engine creds, or a plain reason why not. */
  async function configFor(orgId: string, projectId: string): Promise<{ cfg: AgentTurnConfig } | { error: string; status: number }> {
    const pack = await getPack(db, orgId, projectId);
    if (!pack) return { error: 'no such project', status: 404 };
    const creds = env();
    if (!creds) {
      return { status: 409, error: "The workshop isn't switched on yet — the build engine's credentials aren't configured." };
    }
    const source = pack.topology.sources.find((s) => s.connector === 'github');
    if (!source) {
      return { status: 409, error: "This project has no connected code source yet, so there's nothing for me to work on." };
    }
    return { cfg: { ...creds, repoFullName: source.resource_id, branch: 'main' } };
  }

  async function activeRun(orgId: string, projectId: string) {
    const cutoff = new Date(Date.now() - STUCK_RUN_MS);
    const [row] = await db
      .select({ id: agentRuns.id, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          eq(agentRuns.status, 'running'),
          gte(agentRuns.startedAt, cutoff),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // The page's data: thread, runs, sandbox state, and the cost watch.
  router.get(
    '/api/projects/:projectId/workshop',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }

      const [build, thread, runs, running] = await Promise.all([
        getBuild(db, orgId, projectId),
        db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.projectId, projectId))).orderBy(agentMessages.createdAt),
        db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId))).orderBy(desc(agentRuns.createdAt)).limit(20),
        activeRun(orgId, projectId),
      ]);

      // The cost watch, always visible: what the agent has spent here today and
      // this month, in cents — never a surprise bill. Dates go through drizzle's
      // typed gte() (the driver-correct path), never inside a raw SQL fragment;
      // and a cost-watch failure degrades to zeros with a logged error — it must
      // never take the whole workshop page down.
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const startOfMonth = new Date(Date.UTC(startOfDay.getUTCFullYear(), startOfDay.getUTCMonth(), 1));
      const sumSince = async (since: Date): Promise<number> => {
        const [row] = await db
          .select({ cents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)` })
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), gte(agentRuns.createdAt, since)));
        return Number(row?.cents ?? 0);
      };
      let todayCents = 0;
      let monthCents = 0;
      try {
        [todayCents, monthCents] = await Promise.all([sumSince(startOfDay), sumSince(startOfMonth)]);
      } catch (err) {
        console.error(`workshop cost watch failed for ${orgId}/${projectId}:`, err);
      }

      res.json({
        project: { id: projectId, name: pack.identity.name },
        engine_on: env() !== null,
        working: running !== null,
        staged_changes_ready: build?.stagedChangesReady ?? false,
        sandbox: build?.sandboxId ? 'attached' : 'none',
        thread: thread.map((m) => ({ id: m.id, role: m.role, content: m.content, at: m.createdAt.toISOString() })),
        runs: runs.map((r) => ({ id: r.id, status: r.status, cost_cents: r.costCents, commit: r.commitSha, kind: r.prompt.startsWith('ship:') ? 'ship' : 'turn', at: r.createdAt.toISOString() })),
        cost: { today_cents: todayCents, month_cents: monthCents },
      });
    }),
  );

  // Say what you want; the agent starts on it in the background.
  router.post(
    '/api/projects/:projectId/workshop/message',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you want changed' });
        return;
      }

      const resolved = await configFor(orgId, projectId);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      if (await activeRun(orgId, projectId)) {
        res.status(409).json({ error: "I'm already working on this project — let me finish that first." });
        return;
      }

      // Fire the turn in the background; the page polls the thread. If it can't
      // even start (sandbox failure), the thread gets an honest line — never a
      // silent shrug.
      void runTurn(db, orgId, projectId, text, resolved.cfg).catch(async (err) => {
        console.error(`workshop turn failed to start for ${orgId}/${projectId}:`, err);
        await db
          .insert(agentMessages)
          .values({
            id: ulid(),
            orgId,
            projectId,
            role: 'agent',
            content: `I couldn't get started on that — ${err instanceof Error ? err.message : 'something went wrong'}. Nothing was changed.`,
          })
          .catch(() => undefined);
      });

      res.status(202).json({ started: true });
    }),
  );

  // The live preview URL (brings the app server up if needed).
  router.get(
    '/api/projects/:projectId/workshop/preview',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const resolved = await configFor(orgId, projectId);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      res.json(await preview(db, orgId, projectId, resolved.cfg));
    }),
  );

  // Ship: the one moment the workshop touches the real world — gated on the
  // actual changed files, sensitive changes need a confirmed backup.
  router.post(
    '/api/projects/:projectId/workshop/ship',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const resolved = await configFor(orgId, projectId);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      if (await activeRun(orgId, projectId)) {
        res.status(409).json({ error: "I'm still working — let me finish before we ship." });
        return;
      }
      const body = (req.body ?? {}) as { backup_confirmed?: boolean; summary?: string };
      const out = await shipChanges(db, orgId, projectId, resolved.cfg, {
        backupConfirmed: body.backup_confirmed === true,
        ...(typeof body.summary === 'string' && body.summary.trim() !== '' ? { summary: body.summary.trim() } : {}),
      });
      if (out.outcome === 'shipped') {
        res.json({ shipped: true, commit: out.commit, message: out.message });
        return;
      }
      res.status(out.outcome === 'backup_required' ? 409 : 400).json({ error: out.message, reason: out.outcome });
    }),
  );

  // Undo a ship: a real git revert of exactly that commit, pushed the same way.
  router.post(
    '/api/projects/:projectId/workshop/rollback',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const resolved = await configFor(orgId, projectId);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      const commit = typeof (req.body as { commit?: unknown })?.commit === 'string' ? (req.body as { commit: string }).commit : '';
      const out = await rollbackShip(db, orgId, projectId, resolved.cfg, commit);
      if (!out.ok) {
        res.status(400).json({ error: out.message });
        return;
      }
      res.json({ rolled_back: true, message: out.message });
    }),
  );

  // Cost-watch: stop the sandbox now instead of waiting out the idle timer.
  router.post(
    '/api/projects/:projectId/workshop/stop',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      await stopSandbox(db, orgId, projectId);
      res.json({ stopped: true });
    }),
  );

  return router;
}
