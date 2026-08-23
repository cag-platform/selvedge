import { Router, type Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { agentMessages } from '../../db/schema/index.js';
import { getThread, createThread } from '../../threads/store.js';
import { resolveFuelFor } from '../../connectors/fuel/resolve.js';
import { checkThinkingBudget } from '../../llm/budget.js';
import { recordUsage } from '../../llm/metering.js';
import { chatProviderFor } from '../../chat/turn.js';
import { extractDecision } from '../../decisions/extract.js';
import {
  attachBuildingThread,
  briefAsText,
  briefForThinkingThread,
  briefForThread,
  editDecision,
  getBrief,
  saveDecision,
  withFreshness,
} from '../../decisions/store.js';
import type { AgentId } from '../../../shared/agents.js';
import { canUseDecisionBriefs } from '../../billing/entitlements.js';
import { refuse } from '../middleware/limit.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * PAIRED THREADS — thinking on one side, building on the other, and one short
 * decision between them.
 *
 * Everything here returns the brief WITH its evidence-dating, never without.
 * The feature's known failure is a settled-sounding statement whose settledness
 * nobody checked, and the only defence is that no surface can get hold of one
 * without also getting hold of how far behind the conversation it is.
 *
 * WHAT THE PLAN GATES, AND WHAT IT DELIBERATELY DOESN'T. Extracting a decision
 * is the Pro feature and is refused on Free, at the top of the route, before
 * anything spends. Reading, editing and building from a brief that already
 * exists are NOT gated, for two reasons that are not about generosity:
 *
 *  - The stale-decision check in the message path is a SAFETY GUARD, not a
 *    feature. It stops a builder acting on a decision the thinking has moved
 *    past. Turning a guard off when someone stops paying would make a lapsed
 *    subscription actively more dangerous than no subscription at all.
 *  - A brief made during a Pro month keeps feeding the builder its opening
 *    instruction. Hiding it from the owner while still handing it to the agent
 *    would mean the screen and the work disagree about what is happening, which
 *    is the one thing this product cannot do.
 *
 * So a lapsed owner keeps the briefs they made and cannot make new ones. That
 * is a restriction on the feature, not on the record.
 */
export function createDecisionsRouter(db: Db) {
  const router = Router();

  /** Extract (or refresh) the decision in a thinking thread. */
  router.post(
    '/api/threads/:threadId/decision',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      if (thread.kind !== 'general') {
        res.status(400).json({ error: 'A decision comes out of a thinking conversation, not a building one.' });
        return;
      }
      const allowed = await canUseDecisionBriefs(db, orgId);
      if (!allowed.allowed) {
        refuse(res, allowed);
        return;
      }

      const messages = await db
        .select({ role: agentMessages.role, content: agentMessages.content, at: agentMessages.createdAt })
        .from(agentMessages)
        .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
        .orderBy(agentMessages.createdAt);
      const spoken = messages.filter((m) => m.role === 'owner' || m.role === 'agent');
      if (spoken.length === 0) {
        res.status(400).json({ error: "There's nothing in this conversation yet to decide from." });
        return;
      }

      const budget = await checkThinkingBudget(db, orgId);
      if (budget.over) {
        res.status(429).json({ error: `This account has reached its daily limit for thinking ($${budget.capUsd.toFixed(2)}). It resets tomorrow.` });
        return;
      }
      const provider = chatProviderFor(thread.agent as AgentId) ?? 'anthropic';
      const fuel = await resolveFuelFor(db, orgId, provider).catch(() => null);
      if (!fuel) {
        res.status(409).json({ error: "There's no model key connected, so I can't read the conversation back to you." });
        return;
      }

      const extracted = await extractDecision(fuel.client, provider, spoken);
      // The call is metered whether or not it produced anything usable — it
      // spent tokens either way.
      await recordUsage(db, orgId, 'chat', { ok: true, json: {}, tokensIn: 0, tokensOut: 0, model: 'decision-extract', provider }, undefined, thread.id).catch(
        () => undefined,
      );
      if (!extracted.ok) {
        res.status(422).json({ error: extracted.reason });
        return;
      }

      const brief = await saveDecision(
        db,
        orgId,
        { projectId: thread.projectId, thinkingThreadId: thread.id },
        extracted.draft,
        { through: spoken.at(-1)?.at ?? null, messages: spoken.length },
      );
      res.status(201).json(await withFreshness(db, orgId, brief));
    }),
  );

  /** The decision attached to either half of a pair, with how current it is. */
  router.get(
    '/api/threads/:threadId/decision',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const brief = await briefForThread(db, orgId, req.params.threadId ?? '');
      if (!brief) {
        res.json({ brief: null });
        return;
      }
      res.json(await withFreshness(db, orgId, brief));
    }),
  );

  /** The owner's words replace the extraction's. */
  router.patch(
    '/api/decisions/:id',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch = {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.decision === 'string' ? { decision: body.decision } : {}),
        ...(typeof body.why === 'string' ? { why: body.why } : {}),
        ...(Array.isArray(body.constraints) ? { constraints: (body.constraints as unknown[]).filter((c): c is string => typeof c === 'string') } : {}),
        ...(Array.isArray(body.open_questions)
          ? { openQuestions: (body.open_questions as unknown[]).filter((q): q is string => typeof q === 'string') }
          : {}),
      };
      const brief = await editDecision(db, orgId, req.params.id ?? '', patch);
      if (!brief) {
        res.status(404).json({ error: 'no such decision' });
        return;
      }
      res.json(await withFreshness(db, orgId, brief));
    }),
  );

  /**
   * Start building it: a workshop thread, paired to the decision, opened with
   * the decision as its first instruction — and, when the brief has fallen
   * behind, told so in the same breath.
   */
  router.post(
    '/api/decisions/:id/build',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const brief = await getBrief(db, orgId, req.params.id ?? '');
      if (!brief) {
        res.status(404).json({ error: 'no such decision' });
        return;
      }
      if (!brief.projectId) {
        res.status(409).json({ error: "This decision isn't about a project, so there's no codebase to build it in." });
        return;
      }
      if (brief.buildingThreadId) {
        const existing = await getThread(db, orgId, brief.buildingThreadId);
        if (existing) {
          res.json({ thread: { id: existing.id, title: existing.title }, already: true });
          return;
        }
      }

      const dated = await withFreshness(db, orgId, brief);
      const thread = await createThread(db, orgId, brief.projectId, { kind: 'workshop', title: brief.title });
      await attachBuildingThread(db, orgId, brief.id, thread.id);

      // The decision lands on the building thread as its opening line, so the
      // record of what this work was for is in the work, not only beside it.
      await db.insert(agentMessages).values({
        id: ulid(),
        orgId,
        projectId: brief.projectId,
        threadId: thread.id,
        role: 'switch',
        content: `⇄ built from the decision in "${brief.title}"${dated.freshness.state === 'stale' ? ` — ${dated.freshness.note}` : ''}`,
        meta: { decision: { brief_id: brief.id, thinking_thread_id: brief.thinkingThreadId, freshness: dated.freshness } },
      });

      res.status(201).json({
        thread: { id: thread.id, title: thread.title },
        already: false,
        freshness: dated.freshness,
      });
    }),
  );

  return router;
}

/** Re-exported for the message path, which must consult it before every turn. */
export { briefForThread, briefAsText, briefForThinkingThread, withFreshness };
