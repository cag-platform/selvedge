import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { spendTodayUsd, dailySketchBudgetUsd, SKETCH_PURPOSES } from '../../llm/budget.js';
import { orgs } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { sketchTurn, type SketchDeps } from '../../sketch/converse.js';
import {
  addMessage,
  createSketch,
  deleteSketch,
  getSketch,
  listMessages,
  listSketches,
  markHandedOff,
  setBrief,
  setProject,
  titleFrom,
  type SketchMessageRow,
} from '../../sketch/store.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Sketch's HTTP surface — talk an idea through, then hand the brief to the
 * workshop.
 *
 * Unlike the workshop this answers SYNCHRONOUSLY: a model call takes seconds,
 * not the minutes a sandbox turn takes, so there is no 202-then-poll dance and
 * no one-at-a-time guard to enforce. Ask for the turn, get the thread back.
 *
 * With no model connected, or over the day's sketch budget, it answers 200 with
 * an honest sentence rather than an error — the same contract Ask uses, because
 * a spinner or a red box would both be lies about what happened.
 */

export type SketchRouterDeps = {
  /** Per-org fuel resolution; injected so tests can pass a fake model. */
  resolveDeps?: (orgId: string) => Promise<SketchDeps | undefined>;
  /** Hand the brief to the workshop. Injected so tests don't need the build engine. */
  handOff?: (orgId: string, projectId: string, text: string) => Promise<void>;
};

const NO_MODEL = "There's no AI model connected, so I can't think this through with you yet. Connect one on the Connections page and I'll be right here.";

export function createSketchRouter(db: Db, deps: SketchRouterDeps = {}) {
  const router = Router();

  /** Today's sketch spend and the day's allowance — the cost watch, always visible. */
  async function spend(orgId: string): Promise<{ today_usd: number; cap_usd: number }> {
    try {
      const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
      const [today, cap] = [await spendTodayUsd(db, orgId, new Date(), { only: SKETCH_PURPOSES }), dailySketchBudgetUsd(org?.plan)];
      return { today_usd: today, cap_usd: cap };
    } catch (err) {
      // A cost-watch failure must never take the page down; it degrades to zeros.
      console.error(`sketch spend lookup failed for ${orgId}:`, err);
      return { today_usd: 0, cap_usd: 0 };
    }
  }

  const viewMessage = (m: SketchMessageRow) => ({ id: m.id, role: m.role, content: m.content, at: m.createdAt.toISOString() });

  /**
   * Run one turn and persist both sides. Returns what the client should be
   * told — including the honest non-answers, which are 200s, not errors.
   */
  async function turn(orgId: string, sketchId: string, projectId: string | null, text: string) {
    const resolved = deps.resolveDeps ? await deps.resolveDeps(orgId) : undefined;
    await addMessage(db, orgId, sketchId, 'owner', text);

    if (!resolved) {
      await addMessage(db, orgId, sketchId, 'sketch', NO_MODEL);
      return { available: false };
    }

    const history = (await listMessages(db, orgId, sketchId)).slice(0, -1); // everything before what was just said
    const result = await sketchTurn(resolved, orgId, projectId, history, text);

    if (!result.ok) {
      const line =
        result.reason === 'over_budget'
          ? `That's the day's thinking budget used up ($${result.capUsd.toFixed(2)}). It resets tomorrow — your watching and your daily brief are unaffected.`
          : "I couldn't think that through just now. Nothing was lost — try saying it again.";
      await addMessage(db, orgId, sketchId, 'sketch', line);
      return { available: true, degraded: result.reason };
    }

    await addMessage(db, orgId, sketchId, 'sketch', result.reply.reply);
    // The brief is set OR cleared every turn: a follow-up that reopens a
    // settled question must not leave a stale brief looking ready to build.
    await setBrief(db, orgId, sketchId, result.reply.brief);
    return { available: true, questions: result.reply.questions };
  }

  /** The full thread for one sketch, plus the cost watch. */
  async function view(orgId: string, sketchId: string, extra: Record<string, unknown> = {}) {
    const [sketch, messages, cost] = await Promise.all([
      getSketch(db, orgId, sketchId),
      listMessages(db, orgId, sketchId),
      spend(orgId),
    ]);
    if (!sketch) return null;
    return {
      sketch: {
        id: sketch.id,
        title: sketch.title,
        project_id: sketch.projectId,
        brief: sketch.brief,
        ready: sketch.brief !== null,
        handed_off_at: sketch.handedOffAt?.toISOString() ?? null,
      },
      thread: messages.map(viewMessage),
      cost,
      ...extra,
    };
  }

  router.get(
    '/api/sketches',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const rows = await listSketches(db, orgId);
      res.json({
        sketches: rows.map((s) => ({
          id: s.id,
          title: s.title,
          project_id: s.projectId,
          ready: s.brief !== null,
          handed_off_at: s.handedOffAt?.toISOString() ?? null,
          updated_at: s.updatedAt.toISOString(),
        })),
        cost: await spend(orgId),
      });
    }),
  );

  // Start an idea. The first thing said becomes the title and the first turn.
  router.post(
    '/api/sketches',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const body = req.body as { text?: unknown; project_id?: unknown };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you are thinking about' });
        return;
      }
      let projectId: string | null = null;
      if (typeof body?.project_id === 'string' && body.project_id.trim() !== '') {
        if (!(await getPack(db, orgId, body.project_id))) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        projectId = body.project_id;
      }

      const sketch = await createSketch(db, orgId, titleFrom(text), projectId);
      const outcome = await turn(orgId, sketch.id, projectId, text);
      res.status(201).json(await view(orgId, sketch.id, outcome));
    }),
  );

  router.get(
    '/api/sketches/:sketchId',
    asyncHandler(async (req, res) => {
      const out = await view(orgIdOf(req), req.params.sketchId ?? '');
      if (!out) {
        res.status(404).json({ error: 'no such sketch' });
        return;
      }
      res.json(out);
    }),
  );

  // Keep thinking. Answers synchronously with the updated thread.
  router.post(
    '/api/sketches/:sketchId/messages',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const sketchId = req.params.sketchId ?? '';
      const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you are thinking' });
        return;
      }
      const sketch = await getSketch(db, orgId, sketchId);
      if (!sketch) {
        res.status(404).json({ error: 'no such sketch' });
        return;
      }
      const outcome = await turn(orgId, sketchId, sketch.projectId, text);
      res.json(await view(orgId, sketchId, outcome));
    }),
  );

  // Hand the brief to the workshop — the whole point of the room.
  router.post(
    '/api/sketches/:sketchId/handoff',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const sketchId = req.params.sketchId ?? '';
      const sketch = await getSketch(db, orgId, sketchId);
      if (!sketch) {
        res.status(404).json({ error: 'no such sketch' });
        return;
      }
      if (!sketch.brief) {
        res.status(409).json({ error: "This idea isn't settled enough to build yet — keep talking it through." });
        return;
      }

      const asked = (req.body as { project_id?: unknown })?.project_id;
      const projectId = typeof asked === 'string' && asked.trim() !== '' ? asked : sketch.projectId;
      if (!projectId) {
        res.status(400).json({ error: 'which project should this be built in?' });
        return;
      }
      if (!(await getPack(db, orgId, projectId))) {
        res.status(404).json({ error: 'no such project' });
        return;
      }

      if (deps.handOff) {
        try {
          await deps.handOff(orgId, projectId, sketch.brief);
        } catch (err) {
          // Be honest about a failed handoff rather than navigating the owner
          // to a workshop that never received anything.
          console.error(`sketch handoff failed for ${orgId}/${sketchId}:`, err);
          res.status(502).json({ error: `That didn't reach the workshop — ${err instanceof Error ? err.message : 'something went wrong'}. Nothing was started.` });
          return;
        }
      }
      if (sketch.projectId !== projectId) await setProject(db, orgId, sketchId, projectId);
      await markHandedOff(db, orgId, sketchId);
      res.json({ handed_off: true, project_id: projectId, brief: sketch.brief });
    }),
  );

  router.delete(
    '/api/sketches/:sketchId',
    asyncHandler(async (req, res) => {
      const deleted = await deleteSketch(db, orgIdOf(req), req.params.sketchId ?? '');
      if (!deleted) {
        res.status(404).json({ error: 'no such sketch' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
