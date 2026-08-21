import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { resolveCompanionToken, touchCompanionToken } from '../../companion/tokens.js';
import { recordSession } from '../../companion/sessions.js';
import { contextForProject, listContextProjects, openIssuesFor, recentChangesFor } from '../../companion/context.js';
import { checkSessionSummary } from '../../../shared/types/session.js';

/**
 * THE LOOP'S DOOR — the one surface a program on the owner's machine talks to.
 *
 * Mounted BEFORE the Clerk org guard, because nothing here has a browser or a
 * person behind it: a bearer token issued to one machine stands in for both.
 * Every route resolves that token to an org first and scopes everything to it,
 * so a key is exactly as powerful as the org it was minted in and no more.
 *
 * Two directions, one door:
 *   in  — POST /api/companion/sessions: a summary of a session that happened
 *         somewhere else. Bounded and validated by the same pure checker the
 *         companion runs before sending.
 *   out — GET /api/companion/context/*: the project pack, what changed, what is
 *         open. READ-ONLY: an agent consumes context here, it never writes
 *         memory, because the pack's whole value is that it is grounded in what
 *         happened rather than in what an agent asserted.
 */

export type CompanionRequest = Request & { orgId: string; tokenId: string };

export function companionAuth(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const resolved = await resolveCompanionToken(db, token);
    if (!resolved) {
      // Deliberately identical for a missing, malformed, revoked or unknown key:
      // a caller learning WHICH of those it is learns something about other
      // people's keys.
      res.status(401).json({ error: 'that key is not valid here' });
      return;
    }
    (req as CompanionRequest).orgId = resolved.orgId;
    (req as CompanionRequest).tokenId = resolved.id;
    void touchCompanionToken(db, resolved.id);
    next();
  };
}

export function createCompanionRouter(db: Db) {
  const router = Router();
  router.use('/api/companion', companionAuth(db));

  /** Who am I, and what can this key see? The companion's first call. */
  router.get(
    '/api/companion/hello',
    asyncHandler(async (req, res) => {
      const orgId = (req as CompanionRequest).orgId;
      res.json({ ok: true, projects: await listContextProjects(db, orgId) });
    }),
  );

  /**
   * A session that happened elsewhere. One summary per request; the same
   * session may be sent again (after a restart, or once its commit is known)
   * and updates the row it already has rather than making a second one.
   */
  router.post(
    '/api/companion/sessions',
    asyncHandler(async (req, res) => {
      const orgId = (req as CompanionRequest).orgId;
      const checked = checkSessionSummary(req.body);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      const { projectId } = await recordSession(db, orgId, checked.value);
      res.status(202).json({
        recorded: true,
        project_id: projectId,
        // Said plainly rather than silently filed under nothing: an unmatched
        // session is still kept, and the companion can tell the owner why it
        // isn't showing up on a project.
        ...(projectId ? {} : { note: "I couldn't match that directory to a project, so it's recorded without one." }),
      });
    }),
  );

  /** Every project this key can see — how an agent resolves the repo it is sitting in. */
  router.get(
    '/api/companion/context',
    asyncHandler(async (req, res) => {
      res.json({ projects: await listContextProjects(db, (req as CompanionRequest).orgId) });
    }),
  );

  router.get(
    '/api/companion/context/:projectId',
    asyncHandler(async (req, res) => {
      const context = await contextForProject(db, (req as CompanionRequest).orgId, req.params.projectId ?? '');
      if (!context) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      res.json(context);
    }),
  );

  router.get(
    '/api/companion/context/:projectId/changes',
    asyncHandler(async (req, res) => {
      const orgId = (req as CompanionRequest).orgId;
      const projectId = req.params.projectId ?? '';
      const context = await contextForProject(db, orgId, projectId);
      if (!context) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const raw = Number(req.query.days);
      const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 90) : 14;
      res.json({ days, changes: await recentChangesFor(db, orgId, projectId, days) });
    }),
  );

  router.get(
    '/api/companion/context/:projectId/issues',
    asyncHandler(async (req, res) => {
      const orgId = (req as CompanionRequest).orgId;
      const projectId = req.params.projectId ?? '';
      const context = await contextForProject(db, orgId, projectId);
      if (!context) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      res.json({ issues: await openIssuesFor(db, orgId, projectId) });
    }),
  );

  return router;
}
