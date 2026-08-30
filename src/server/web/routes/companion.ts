import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { checkConversationBatch } from '../../import/companionIngest.js';
import { fileConversations } from '../../import/consumer/store.js';
import { importSummary } from '../../import/consumer/read.js';
import { VENDOR_NAMES } from '../../import/consumer/types.js';
import { ensureSubject } from '../../threads/subjects.js';
import { resolveCompanionToken, touchCompanionToken } from '../../companion/tokens.js';
import { recordSession } from '../../companion/sessions.js';
import { contextForProject, listContextProjects, openIssuesFor, recentChangesFor } from '../../companion/context.js';
import { checkSessionSummary } from '../../../shared/types/session.js';
import {
  APPLE_RUNTIME_HEARTBEAT_MS, checkAppleRuntimeRegistration, connectAppleRuntime,
  appleWorkspaceCheckpoint, assignedAppleRuntimeJob, claimAppleRuntimeJob, disconnectAppleRuntime,
  finishAppleRuntimeJob, heartbeatAppleRuntime, storeAppleWorkspaceCheckpoint, type AppleChatTurnRequest,
} from '../../companion/appleRuntime.js';
import { resolveRepoToken } from '../../build/repoToken.js';

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

  router.post(
    '/api/companion/runtime/apple/connect',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const checked = checkAppleRuntimeRegistration(req.body);
      if (!checked) {
        res.status(400).json({ error: 'Xcode and an available iPhone Simulator are required for an Apple runtime.' });
        return;
      }
      const host = await connectAppleRuntime(db, owner.orgId, owner.tokenId, checked);
      res.status(201).json({ connected: true, host_id: host.id, heartbeat_seconds: APPLE_RUNTIME_HEARTBEAT_MS / 1000 });
    }),
  );

  router.get(
    '/api/companion/runtime/apple/jobs/:jobId/source',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const job = await assignedAppleRuntimeJob(db, owner.orgId, owner.tokenId, req.params.jobId ?? '');
      if (!job || job.kind !== 'chat_turn' || !job.projectId) {
        res.status(404).json({ error: 'No assigned Apple project source for this Mac.' });
        return;
      }
      const request = job.request as AppleChatTurnRequest;
      const checkpoint = await appleWorkspaceCheckpoint(db, owner.orgId, job.projectId);
      if (checkpoint) {
        res.setHeader('x-selvedge-archive-layout', 'workspace');
        res.type('application/gzip').send(checkpoint);
        return;
      }
      if (request.emptyRepo) {
        res.setHeader('x-selvedge-archive-layout', 'empty');
        res.status(204).end();
        return;
      }
      const token = await resolveRepoToken(db, owner.orgId, request.repoFullName);
      if (!token.ok) {
        res.status(409).json({ error: token.reason });
        return;
      }
      const source = await fetch(`https://api.github.com/repos/${request.repoFullName}/tarball/${encodeURIComponent(request.branch)}`, {
        headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Selvedge Apple Runtime' },
      });
      if (!source.ok || !source.body) {
        res.status(502).json({ error: `GitHub could not prepare the Apple project source (${source.status}).` });
        return;
      }
      const bytes = Buffer.from(await source.arrayBuffer());
      if (bytes.byteLength > 100 * 1024 * 1024) {
        res.status(413).json({ error: 'The Apple project source is larger than 100 MB.' });
        return;
      }
      res.setHeader('x-selvedge-archive-layout', 'github');
      res.type('application/gzip').send(bytes);
    }),
  );

  router.post(
    '/api/companion/runtime/apple/jobs/:jobId/archive',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const job = await assignedAppleRuntimeJob(db, owner.orgId, owner.tokenId, req.params.jobId ?? '');
      if (!job || job.kind !== 'chat_turn' || !job.projectId || !Buffer.isBuffer(req.body)) {
        res.status(409).json({ error: 'That Apple workspace upload is not assigned to this Mac.' });
        return;
      }
      const request = job.request as AppleChatTurnRequest;
      await storeAppleWorkspaceCheckpoint(db, owner.orgId, job.projectId, request.runId, request.threadId, request.agent, req.body);
      res.json({ stored: true, bytes: req.body.byteLength });
    }),
  );

  router.post(
    '/api/companion/runtime/apple/heartbeat',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const host = await heartbeatAppleRuntime(db, owner.orgId, owner.tokenId);
      if (!host) {
        res.status(409).json({ error: 'This Mac is not registered as an Apple runtime. Reconnect it.' });
        return;
      }
      res.json({ connected: true });
    }),
  );

  router.delete(
    '/api/companion/runtime/apple',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      await disconnectAppleRuntime(db, owner.orgId, owner.tokenId);
      res.json({ disconnected: true });
    }),
  );

  router.post(
    '/api/companion/runtime/apple/jobs/claim',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const job = await claimAppleRuntimeJob(db, owner.orgId, owner.tokenId);
      res.json({ job: job ? { id: job.id, kind: job.kind, request: job.request } : null });
    }),
  );

  router.post(
    '/api/companion/runtime/apple/jobs/:jobId/complete',
    asyncHandler(async (req, res) => {
      const owner = req as CompanionRequest;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.ok !== 'boolean') {
        res.status(400).json({ error: 'A bounded Apple runtime result is required.' });
        return;
      }
      const text = (name: string, max: number) => typeof body[name] === 'string' ? String(body[name]).slice(0, max) : undefined;
      const job = await finishAppleRuntimeJob(db, owner.orgId, owner.tokenId, req.params.jobId ?? '', {
        ok: body.ok,
        xcodeVersion: text('xcodeVersion', 500), simulatorName: text('simulatorName', 200),
        macosVersion: text('macosVersion', 200), detail: text('detail', 2_000), narrative: text('narrative', 12_000),
        buildOutput: text('buildOutput', 12_000),
        changedPaths: Array.isArray(body.changedPaths) ? body.changedPaths.filter((path): path is string => typeof path === 'string').slice(0, 200).map((path) => path.slice(0, 500)) : undefined,
      });
      if (!job) {
        res.status(409).json({ error: 'That Apple runtime job is not assigned to this Mac.' });
        return;
      }
      res.json({ recorded: true });
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

  /**
   * A HISTORY NO VENDOR EXPORTS, delivered by the companion.
   *
   * Cursor's chats live in a local SQLite file with no download button, so
   * `selvedge import cursor` reads them on the owner's machine and sends them
   * here in chunks. Same pipe as the zip imports underneath — same dedupe by
   * (vendor, sourceId), so re-running the command is a no-op rather than a
   * doubling, and same honesty rule: what could not be read is counted in the
   * summary, never silently dropped.
   *
   * Filed under "<Vendor> history", account-wide — the CLI names no project,
   * because a year of editor chats is not "about" any one repo, and the
   * filing screen exists for the ones that are.
   */
  router.post(
    '/api/companion/import/conversations',
    asyncHandler(async (req, res) => {
      const orgId = (req as CompanionRequest).orgId;
      const checked = checkConversationBatch(req.body);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      const { vendor, conversations, unreadable } = checked.value;
      const home = await ensureSubject(db, orgId, `${VENDOR_NAMES[vendor]} history`);
      const filed = await fileConversations(db, orgId, { subjectId: home.id }, vendor, conversations);
      res.json({
        filed: filed.filed,
        already_had: filed.alreadyHad,
        unreadable: unreadable.length,
        subject_id: home.id,
        summary: importSummary(vendor, filed.filed, unreadable.length, `${VENDOR_NAMES[vendor]} history`),
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
