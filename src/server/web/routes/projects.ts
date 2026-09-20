import { Router, type Request } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectBuild, agentRuns, agentRunEvents, agentMessages } from '../../db/schema/index.js';
import { rollup, projectRunStatus, recordRunEvent } from '../../workspace/coordinator.js';
import { recoverRun } from '../../workspace/recovery.js';
import { hibernateWorkspace } from '../../build/sandbox.js';
import { listPacks, mutedProjectIds } from '../../packs/store.js';
import { edgeStatus, hasHealthSignal, healthLine } from '../../packs/healthLine.js';
import { consoleLinks } from '../../connectors/consoles.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { claimUrl, createTransferRequest, NeonClaimError } from '../../connectors/neon/claim.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Projects list (deliverable 8): pack cards with name, plain health line, links out. */
export type ProjectsDeps = {
  /** Injected in tests — the real one talks to Neon with the platform key. */
  createTransfer?: typeof createTransferRequest;
};

export function createProjectsRouter(db: Db, deps: ProjectsDeps = {}) {
  const router = Router();
  const createTransfer = deps.createTransfer ?? createTransferRequest;

  router.get(
    '/api/projects',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      // Archived (permanently deleted) projects are excluded by default; muted
      // ones are included but flagged so the client can collapse them.
      const [packs, muted, buildRows, runRows] = await Promise.all([
        listPacks(db, orgId),
        mutedProjectIds(db, orgId),
        db.select({ projectId: projectBuild.projectId, stagedChangesReady: projectBuild.stagedChangesReady }).from(projectBuild).where(eq(projectBuild.orgId, orgId)),
        db.select({ projectId: agentRuns.projectId, lifecycle: agentRuns.lifecycle, reviewedAt: agentRuns.reviewedAt }).from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.runRole, 'builder'), isNull(agentRuns.reviewedAt))),
      ]);
      const buildByProject = new Map(buildRows.map((row) => [row.projectId, row]));
      res.json(
        packs.map((pack) => ({
          project_id: pack.identity.project_id,
          work_status: rollup(runRows.filter(r => r.projectId === pack.identity.project_id)),
          name: pack.identity.name,
          tier: pack.stakes.tier,
          // Null where nothing has reported — see hasHealthSignal.
          health_line: hasHealthSignal(pack) ? healthLine(pack) : null,
          edge: hasHealthSignal(pack) ? edgeStatus(pack) : null,
          review_ready: buildByProject.get(pack.identity.project_id)?.stagedChangesReady ?? false,
          online: Boolean(pack.identity.links?.live_url),
          links: pack.identity.links ?? {},
          // The doors to the accounts behind it — see connectors/consoles.ts.
          console_links: consoleLinks(pack),
          muted: muted.has(pack.identity.project_id),
        })),
      );
    }),
  );

  router.get('/api/projects/:projectId/workspace', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId!;
    if (!await getPack(db, orgId, projectId)) { res.status(404).json({ error: 'No such project' }); return; }
    const state = await projectRunStatus(db, orgId, projectId);
    res.json(state);
  }));

  router.get('/api/projects/:projectId/runs/:runId/events', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, req.params.projectId!), eq(agentRuns.id, req.params.runId!)));
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    const events = await db.select().from(agentRunEvents).where(and(eq(agentRunEvents.orgId, orgId), eq(agentRunEvents.runId, run.id))).orderBy(agentRunEvents.sequence);
    res.json({ run, events });
  }));

  router.post('/api/projects/:projectId/runs/:runId/reviewed', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, req.params.projectId!), eq(agentRuns.id, req.params.runId!)));
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    if (!['ready', 'failed', 'cancelled'].includes(run.lifecycle)) { res.status(409).json({ error: 'This run is still active' }); return; }
    res.json(await recordRunEvent(db, orgId, run.id, { key: 'reviewed', kind: 'reviewed', source: 'owner' }));
  }));

  router.post('/api/projects/:projectId/runs/:runId/recover', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, req.params.projectId!), eq(agentRuns.id, req.params.runId!)));
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    res.json(await recoverRun(db, orgId, req.params.projectId!, run.id));
  }));

  router.post('/api/projects/:projectId/runs/:runId/respond', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, req.params.projectId!), eq(agentRuns.id, req.params.runId!)));
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    const body = req.body as { text?: unknown; accepted_answer_id?: unknown; accept_recovered_result?: unknown };
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 200 || typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 24000) { res.status(400).json({ error: 'Supply a response and a bounded Idempotency-Key.' }); return; }
    let accepted: { id: string; content: string } | undefined;
    if (typeof body.accepted_answer_id === 'string') {
      [accepted] = await db.select({ id: agentMessages.id, content: agentMessages.content }).from(agentMessages)
        .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.projectId, run.projectId), eq(agentMessages.id, body.accepted_answer_id), eq(agentMessages.role, 'agent')));
      if (!accepted) { res.status(404).json({ error: 'No such project answer' }); return; }
    }
    const updated = await recordRunEvent(db, orgId, run.id, { key: `owner-response:${key}`, kind: 'owner_response', source: 'owner', payload: { answer: body.text.trim(), ...(accepted ? { acceptedAnswerId: accepted.id, acceptedAnswer: accepted.content } : {}) } });
    await db.insert(agentMessages).values({ id: `response:${run.id}:${key}`, orgId, projectId: run.projectId, threadId: run.threadId, role: 'owner', content: body.text.trim(), runId: run.id,
      meta: { ...(accepted ? { accepted_answer_id: accepted.id } : {}), owner_response: true } }).onConflictDoNothing();
    if (body.accept_recovered_result === true) {
      await recordRunEvent(db, orgId, run.id, { key: `accept-recovered:${key}`, kind: 'recovered_result_accepted', source: 'owner' });
    }
    // Recording a decision is not an acknowledgement from a running agent.
    res.json({ recorded: true, run_id: run.id, event_version: updated.eventVersion, execution_resumed: false, next_action: 'Continue with a new builder turn after the prior execution is confirmed complete.' });
  }));

  router.post('/api/projects/:projectId/runs/:runId/hibernate', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, req.params.projectId!), eq(agentRuns.id, req.params.runId!)));
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    if (run.runRole !== 'builder' || !['ready', 'failed', 'cancelled'].includes(run.lifecycle)) { res.status(409).json({ error: 'Stop the builder before hibernating.' }); return; }
    const state = await hibernateWorkspace(db, orgId, run.projectId, run.id, true);
    res.status(state === 'busy' || state === 'preview_active' ? 409 : 200).json({ state });
  }));

  /**
   * MAKE THE DATABASE THEIRS. Provisioned databases live on Selvedge's Neon
   * account — the convenience of zero-signup go-live, at the cost of custody.
   * This mints Neon's own transfer request and hands back the claim URL; the
   * ACCEPT happens in the owner's browser with their own Neon session, and
   * connection strings do not change, so the running app never notices.
   * See connectors/neon/claim.ts.
   */
  router.post(
    '/api/projects/:projectId/database/claim',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const neon = pack.topology.sources.find((s) => s.connector === 'neon');
      if (!neon) {
        res.status(409).json({ error: 'this project has no Selvedge-provisioned database to claim.' });
        return;
      }
      try {
        const transfer = await createTransfer(neon.resource_id);
        res.json({
          claim_url: claimUrl(neon.resource_id, transfer.id),
          expires_at: transfer.expiresAt,
          note: 'Open it, sign in to your own Neon account, and the database moves — connection strings stay the same, so the app keeps running.',
        });
      } catch (err) {
        if (err instanceof NeonClaimError) {
          res.status(502).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}
