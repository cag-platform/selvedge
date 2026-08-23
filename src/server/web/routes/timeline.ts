import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { projectTimeline, searchProject } from '../../timeline/store.js';
import { historyWindow } from '../../billing/entitlements.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The record, made visible: one project's history, and search inside it.
 *
 * Both are read-only projections of data the owner already has — nothing here
 * writes, and nothing here composes with a model. The window defaults to a
 * fortnight because that is the question people actually ask ("what happened to
 * this in the last two weeks?"), and `days=0` means everything.
 *
 * THE PLAN'S HISTORY WINDOW IS APPLIED HERE, at the route, and NOT in
 * `timeline/store.ts`. That placement is the whole design: the store stays the
 * honest, unrestricted projection of the record, so the export path
 * (memory/portability.ts calls the same function) carries everything regardless
 * of plan. Export ignoring the plan is a promise kept by there being no call
 * site to gate — not by a flag somewhere reading "except export".
 *
 * And what is past the window is LOCKED, NOT GONE. The count of what's behind
 * the lock is returned with every response, because "142 older items" is a fact
 * the owner is entitled to even when the items themselves aren't shown. A
 * window that silently returns fewer rows is the same lie as a truncated list
 * that doesn't say it truncated.
 */
const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

/**
 * Split what the caller asked for into what they may see and how much they may
 * not. Both timeline entries and search hits carry `at`, so one function serves
 * both — and both are filtered AFTER the query rather than before, which costs
 * nothing extra (the wider query is the one a paying owner runs anyway) and
 * keeps the count exact rather than estimated.
 */
function applyWindow<T extends { at: string }>(rows: T[], since: Date | null): { visible: T[]; lockedOlderCount: number } {
  if (!since) return { visible: rows, lockedOlderCount: 0 };
  const floor = since.getTime();
  const visible = rows.filter((r) => new Date(r.at).getTime() >= floor);
  return { visible, lockedOlderCount: rows.length - visible.length };
}

export function createTimelineRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/projects/:projectId/timeline',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const raw = Number(req.query.days);
      const days = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, MAX_DAYS) : DEFAULT_DAYS;
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;

      const window = await historyWindow(db, orgId);
      const entries = await projectTimeline(db, orgId, projectId, { ...(since ? { since } : {}) });
      const { visible, lockedOlderCount } = applyWindow(entries, window.since);

      res.json({
        project: { id: projectId, name: pack.identity.name },
        // So a commit on an entry can become a link to the actual diff.
        repo_url: pack.identity.links?.repo_url ?? null,
        days,
        entries: visible,
        locked_older_count: lockedOlderCount,
        // Null when nothing is locked, so the client has one thing to check
        // rather than two — and the sentence comes from the shared plan table.
        locked_note: lockedOlderCount > 0 ? window.note : null,
      });
    }),
  );

  router.get(
    '/api/projects/:projectId/search',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const window = await historyWindow(db, orgId);
      const { visible, lockedOlderCount } = applyWindow(await searchProject(db, orgId, projectId, q), window.since);

      // A search that quietly drops matches is worse than one that finds
      // nothing: it teaches the owner their record doesn't contain something it
      // does contain. So the count of suppressed matches always rides along.
      res.json({
        query: q,
        hits: visible,
        locked_older_count: lockedOlderCount,
        locked_note: lockedOlderCount > 0 ? window.note : null,
      });
    }),
  );

  return router;
}
