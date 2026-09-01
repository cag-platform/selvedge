import { and, asc, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { agentMessages, agentRuns, cards, packs, projectBuild, threads } from '../../db/schema/index.js';
import type { ContextPack } from '../../../shared/types/pack.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const PROJECT_ID = 'demo-relay';

type ToolRecord = { name?: unknown; detail?: unknown; ok?: unknown; note?: unknown };

function publicTools(meta: unknown) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const tools = (meta as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 8).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const tool = value as ToolRecord;
    if (typeof tool.name !== 'string' || typeof tool.detail !== 'string') return [];
    return [{ name: tool.name, detail: tool.detail, ok: tool.ok !== false, ...(typeof tool.note === 'string' ? { note: tool.note } : {}) }];
  });
}

/**
 * A deliberately narrow public window into one isolated marketing project.
 * It reads the same persisted rows as the signed-in workspace, but returns
 * only copy and state authored by the demo seeder. No org id, credentials,
 * repository location, sandbox id, tokens, or customer rows cross this edge.
 */
export function createShowcaseRouter(db: Db) {
  const router = Router();
  router.get('/showcase/relay', asyncHandler(async (_req, res) => {
    const rows = await db.select().from(packs).where(eq(packs.projectId, PROJECT_ID)).limit(2);
    if (rows.length !== 1) {
      res.status(503).json({ error: 'The live showcase project is unavailable.' });
      return;
    }
    const row = rows[0]!;
    const orgId = row.orgId;
    const [threadRows, messageRows, runRows, cardRows, buildRows] = await Promise.all([
      db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.projectId, PROJECT_ID))).orderBy(desc(threads.createdAt)).limit(1),
      db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.projectId, PROJECT_ID))).orderBy(asc(agentMessages.createdAt)).limit(20),
      db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, PROJECT_ID))).orderBy(desc(agentRuns.createdAt)).limit(5),
      db.select().from(cards).where(and(eq(cards.orgId, orgId), eq(cards.projectId, PROJECT_ID))).orderBy(desc(cards.updatedAt)).limit(5),
      db.select().from(projectBuild).where(and(eq(projectBuild.orgId, orgId), eq(projectBuild.projectId, PROJECT_ID))).limit(1),
    ]);
    // Project ids are stable demo fixtures, but the org scoping is still
    // checked explicitly so a colliding row can never be joined by accident.
    const sameOrg = <T extends { orgId: string }>(values: T[]) => values.filter((value) => value.orgId === orgId);
    const pack = row.pack as ContextPack;
    const build = sameOrg(buildRows)[0];
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30').json({
      observed_at: new Date().toISOString(),
      project: {
        name: pack.identity.name,
        description: pack.identity.owner_description,
        healthy: Boolean(pack.state?.serving_now?.healthy),
        live_url: '/demo-apps/relay',
      },
      thread: sameOrg(threadRows).map((thread) => ({ title: thread.title, agent: thread.agent }))[0] ?? null,
      messages: sameOrg(messageRows).map((message) => ({
        role: message.role,
        content: message.content,
        created_at: message.createdAt.toISOString(),
        tools: publicTools(message.meta),
        answered_by: message.meta && typeof message.meta === 'object' && !Array.isArray(message.meta)
          ? ((message.meta as { answered_by?: unknown }).answered_by ?? null)
          : null,
      })),
      runs: sameOrg(runRows).map((run) => ({
        agent: run.agent,
        model: run.model,
        status: run.status,
        verdict: run.verdict,
        changed_paths: Array.isArray(run.changedPaths) ? run.changedPaths.filter((path): path is string => typeof path === 'string').slice(0, 12) : [],
        started_at: run.startedAt?.toISOString() ?? null,
        finished_at: run.finishedAt?.toISOString() ?? null,
      })),
      cards: sameOrg(cardRows).map((card) => ({ title: card.title, state: card.state, verdict: card.verdict, graded_by: card.gradedBy })),
      workspace: build ? {
        preview_available: Boolean(build.previewUrl || pack.identity.links?.live_url),
        operation_status: build.previewOperationStatus,
        staged_changes_ready: build.stagedChangesReady,
        evidence_available: Boolean(build.previewEvidence),
      } : null,
    });
  }));
  return router;
}
