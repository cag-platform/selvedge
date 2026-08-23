import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import {
  assignUnsortedSource,
  ignoreSource,
  listIgnoredSources,
  listUnsortedEvents,
  listUnsortedSources,
  unignoreSource,
  watchSource,
} from '../../resolution/unsortedTray.js';
import type { ConnectorKind } from '../../../shared/types/event.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { canCreateProject } from '../../billing/entitlements.js';
import { refuse } from '../middleware/limit.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export type TrayRouterDeps = {
  /** Seed 30 days of history for a repo the owner has just started watching. */
  backfill?: (orgId: string, repo: string) => Promise<void>;
};

function sourceFrom(req: Request): { connector: ConnectorKind; resourceId: string } | null {
  const { connector, resource_id: resourceId } = req.body as { connector?: ConnectorKind; resource_id?: string };
  if (!connector || !resourceId) return null;
  return { connector, resourceId };
}

/**
 * THE UNSORTED TRAY — three answers, not one.
 *
 * It used to offer exactly one ("this belongs to an existing project"), which
 * meant a repo you hadn't set up yet, and anything that simply wasn't yours to
 * care about, sat there forever. A tray that only grows stops being read.
 */
export function createTrayRouter(db: Db, deps: TrayRouterDeps = {}) {
  const router = Router();

  // The flat event list, unchanged: the primitive the rail's count is built on.
  router.get(
    '/api/tray',
    asyncHandler(async (req, res) => {
      const items = await listUnsortedEvents(db, orgIdOf(req));
      res.json(
        items.map((e) => ({
          id: e.id,
          source: e.source,
          source_account_id: e.sourceAccountId,
          event_type: e.eventType,
          occurred_at: e.occurredAt,
        })),
      );
    }),
  );

  // What the owner actually acts on: one row per source, named as what it is.
  router.get(
    '/api/tray/sources',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const [sources, ignored] = await Promise.all([listUnsortedSources(db, orgId), listIgnoredSources(db, orgId)]);
      res.json({
        sources: sources.map((s) => ({
          connector: s.connector,
          resource_id: s.resourceId,
          label: s.label,
          is_repo: s.isRepo,
          count: s.count,
          last_seen: s.lastSeen,
        })),
        ignored: ignored.map((s) => ({
          connector: s.connector,
          resource_id: s.resourceId,
          label: s.label,
          is_repo: s.isRepo,
        })),
      });
    }),
  );

  router.post(
    '/api/tray/assign',
    asyncHandler(async (req, res) => {
      const { connector, resource_id: resourceId, project_id: projectId } = req.body as {
        connector: ConnectorKind;
        resource_id: string;
        project_id: string;
      };
      if (!connector || !resourceId || !projectId) {
        res.status(400).json({ error: 'connector, resource_id, and project_id are required' });
        return;
      }
      try {
        const result = await assignUnsortedSource(db, orgIdOf(req), connector, resourceId, projectId);
        res.json(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('No pack')) {
          res.status(404).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  /**
   * WATCH IT — make a project from the repo the tray already knew about.
   * Everything waiting from that repo lands on it in the same breath, and the
   * history seeds in the background so the project isn't born empty.
   */
  router.post(
    '/api/tray/watch',
    asyncHandler(async (req, res) => {
      const source = sourceFrom(req);
      if (!source) {
        res.status(400).json({ error: 'connector and resource_id are required' });
        return;
      }
      const orgId = orgIdOf(req);
      // Watching a repo makes a project, so it counts. Refusing here leaves the
      // source exactly where it was — in the tray, still listed, still
      // assignable to a project that already exists — which is the whole reason
      // the tray is a safe place for a limit to bite.
      const room = await canCreateProject(db, orgId);
      if (!room.allowed) {
        refuse(res, room);
        return;
      }
      let result: Awaited<ReturnType<typeof watchSource>>;
      try {
        result = await watchSource(db, orgId, source.connector, source.resourceId);
      } catch (err) {
        res.status(422).json({ error: err instanceof Error ? err.message : 'that could not become a project' });
        return;
      }
      if (deps.backfill) {
        void deps.backfill(orgId, source.resourceId).catch((err) => {
          console.error(`backfill after watch failed for ${orgId}/${source.resourceId}:`, err);
        });
      }
      res.status(201).json({ project_id: result.projectId, name: result.name, updated_count: result.updatedCount });
    }),
  );

  router.post(
    '/api/tray/ignore',
    asyncHandler(async (req, res) => {
      const source = sourceFrom(req);
      if (!source) {
        res.status(400).json({ error: 'connector and resource_id are required' });
        return;
      }
      await ignoreSource(db, orgIdOf(req), source.connector, source.resourceId);
      res.json({ ignored: true });
    }),
  );

  router.post(
    '/api/tray/unignore',
    asyncHandler(async (req, res) => {
      const source = sourceFrom(req);
      if (!source) {
        res.status(400).json({ error: 'connector and resource_id are required' });
        return;
      }
      await unignoreSource(db, orgIdOf(req), source.connector, source.resourceId);
      res.json({ ignored: false });
    }),
  );

  return router;
}
