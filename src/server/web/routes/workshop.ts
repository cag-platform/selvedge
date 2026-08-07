import fsp from 'node:fs/promises';
import os from 'node:os';
import { Router, type Request } from 'express';
import multer from 'multer';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { agentMessages, agentMessageAttachments, agentRuns } from '../../db/schema/index.js';
import { getBuild } from '../../build/store.js';
import { runAgentTurn, type AgentTurnConfig, type AttachedImage, type AttachedFile } from '../../build/agent.js';
import { stageUpload, consumeStagedUpload } from '../../build/uploads.js';
import { ensurePreview, type PreviewStatus } from '../../build/preview.js';
import { stopSandbox, type SandboxConfig } from '../../build/sandbox.js';
import { shipChanges, rollbackShip, observeAfterShip } from '../../build/ship.js';
import { goLive } from '../../build/golive.js';

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

// Files for the agent to analyze, dissect, or learn from while building.
//
// Screenshots are small (a UI mockup), so they ride inline as base64 in the
// message body — one request, no round trip. Docs/code/zips can be large
// (a full app export, a data dump), so they go through a separate staged-
// upload endpoint first: multer streams the bytes straight to local disk
// (bounded memory regardless of size), the message then references the
// staged upload by id, and the turn streams it from disk into the sandbox —
// the whole file is never held at once in this process's memory or a JSON
// string.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // ~8M base64 chars, inline in the message body
const MAX_FILES = 5;
/** Generous — disk-streamed, not memory-buffered, so size isn't the risk a JSON body would make it. */
const MAX_STAGED_FILE_BYTES = 300 * 1024 * 1024;

function base64ByteLength(s: string): number {
  return Math.floor((s.length * 3) / 4);
}

/** Validate the message body's inline images; returns a plain-English error, or none. */
function validateImages(images: unknown): { error: string } | { images: AttachedImage[] } {
  const out: AttachedImage[] = [];
  if (images !== undefined) {
    if (!Array.isArray(images)) return { error: 'images must be a list' };
    if (images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images per message` };
    for (const img of images) {
      const mime = (img as { mime?: unknown })?.mime;
      const dataBase64 = (img as { dataBase64?: unknown })?.dataBase64;
      if (typeof mime !== 'string' || !IMAGE_MIMES.has(mime)) return { error: 'images must be PNG, JPEG, WebP, or GIF' };
      if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return { error: 'an image is missing its data' };
      if (base64ByteLength(dataBase64) > MAX_IMAGE_BYTES) return { error: `an image is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB` };
      out.push({ mime, dataBase64 });
    }
  }
  return { images: out };
}

/** Validate the message body's file refs are shaped right (ids to resolve later); returns a plain-English error, or none. */
function validateFileRefs(files: unknown): { error: string } | { ids: string[] } {
  if (files === undefined) return { ids: [] };
  if (!Array.isArray(files)) return { error: 'files must be a list' };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per message` };
  const ids: string[] = [];
  for (const f of files) {
    const id = (f as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.trim() === '') return { error: 'a file is missing its upload id — try attaching it again' };
    ids.push(id);
  }
  return { ids };
}

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
  /** Injected for tests; defaults to the real provisioning flow. */
  goLive?: typeof goLive;
  preview?: (db: Db, orgId: string, projectId: string, cfg: SandboxConfig) => Promise<PreviewStatus>;
  env?: () => { claudeCodeOauthToken: string; githubToken: string } | null;
};

export function createWorkshopRouter(db: Db, deps: WorkshopDeps = {}) {
  const router = Router();
  const runTurn = deps.runTurn ?? runAgentTurn;
  const preview = deps.preview ?? ensurePreview;
  const env = deps.env ?? engineEnv;

  /** The pack's GitHub source + engine creds, or a plain reason why not. */
  async function configFor(orgId: string, projectId: string): Promise<{ cfg: AgentTurnConfig; liveUrl: string | null } | { error: string; status: number }> {
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
    return { cfg: { ...creds, repoFullName: source.resource_id, branch: 'main' }, liveUrl: pack.identity.links?.live_url ?? null };
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

      // Attachment refs (ids + mime only — bytes are served separately, on
      // request, so loading the thread never has to move image bytes around).
      // A lookup hiccup degrades to no thumbnails, not a broken thread.
      const attByMessage = new Map<string, Array<{ id: string; mime: string }>>();
      const messageIds = thread.map((m) => m.id);
      if (messageIds.length) {
        try {
          const atts = await db
            .select({ id: agentMessageAttachments.id, mime: agentMessageAttachments.mime, agentMessageId: agentMessageAttachments.agentMessageId })
            .from(agentMessageAttachments)
            .where(
              and(
                eq(agentMessageAttachments.orgId, orgId),
                eq(agentMessageAttachments.projectId, projectId),
                inArray(agentMessageAttachments.agentMessageId, messageIds),
              ),
            );
          for (const a of atts) {
            const list = attByMessage.get(a.agentMessageId) ?? [];
            list.push({ id: a.id, mime: a.mime });
            attByMessage.set(a.agentMessageId, list);
          }
        } catch (err) {
          console.error(`workshop attachment lookup failed for ${orgId}/${projectId}:`, err);
        }
      }

      res.json({
        project: { id: projectId, name: pack.identity.name },
        live_url: pack.identity.links?.live_url ?? null,
        engine_on: env() !== null,
        working: running !== null,
        staged_changes_ready: build?.stagedChangesReady ?? false,
        sandbox: build?.sandboxId ? 'attached' : 'none',
        thread: thread.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          at: m.createdAt.toISOString(),
          attachments: attByMessage.get(m.id) ?? [],
        })),
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
      const body = req.body as { text?: unknown; images?: unknown; files?: unknown; mode?: unknown };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you want changed' });
        return;
      }
      // 'plan' runs the turn read-only: think it through, change nothing.
      // Per-message, never sticky — the default is always to build.
      const mode = body?.mode === undefined || body.mode === 'build' ? 'build' : body.mode === 'plan' ? 'plan' : null;
      if (mode === null) {
        res.status(400).json({ error: "mode must be 'build' or 'plan'" });
        return;
      }
      const images = validateImages(body?.images);
      if ('error' in images) {
        res.status(400).json({ error: images.error });
        return;
      }
      const fileRefs = validateFileRefs(body?.files);
      if ('error' in fileRefs) {
        res.status(400).json({ error: fileRefs.error });
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

      // Check each staged upload out of the registry now — right before firing,
      // so nothing is consumed (and then orphaned) by a request that was going
      // to fail one of the checks above anyway. Any missing id (expired, wrong
      // project, already used) fails the whole message; whatever was already
      // checked out gets its temp file cleaned up rather than left behind.
      const consumed: Array<{ path: string }> = [];
      const files: AttachedFile[] = [];
      for (const id of fileRefs.ids) {
        const staged = consumeStagedUpload(orgId, projectId, id);
        if (!staged) {
          await Promise.all(consumed.map((s) => fsp.unlink(s.path).catch(() => undefined)));
          res.status(400).json({ error: "one of those files wasn't found — try attaching it again" });
          return;
        }
        consumed.push(staged);
        files.push({ name: staged.name, mime: staged.mime, localPath: staged.path });
      }

      // Fire the turn in the background; the page polls the thread. If it can't
      // even start (sandbox failure), the thread gets an honest line — never a
      // silent shrug.
      void runTurn(db, orgId, projectId, text, resolved.cfg, { images: images.images, files, mode }).catch(async (err) => {
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

  // Stage a file (doc, code, .zip) before sending a message — multer streams
  // it straight to local disk, so its size is bounded by disk, not by this
  // process's memory. The returned id is what the message body references.
  const stageFile = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_STAGED_FILE_BYTES, files: 1 } }).single('file');
  router.post(
    '/api/projects/:projectId/workshop/uploads',
    (req, res, next) => {
      stageFile(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        const code = (err as { code?: string })?.code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: `that file is over ${Math.round(MAX_STAGED_FILE_BYTES / (1024 * 1024))}MB` });
          return;
        }
        res.status(400).json({ error: 'could not read that file' });
      });
    },
    asyncHandler(async (req, res) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ error: 'no file was sent' });
        return;
      }
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        await fsp.unlink(file.path).catch(() => undefined);
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const staged = await stageUpload(orgId, projectId, file.originalname, file.mimetype || 'application/octet-stream', file.path, file.size);
      res.status(201).json({ id: staged.id, name: staged.name, size: staged.size });
    }),
  );

  // An attached image's bytes. Joined through agent_messages so an attachment
  // can only be fetched via the project (and org) it belongs to.
  router.get(
    '/api/projects/:projectId/workshop/attachments/:attachmentId',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const attachmentId = req.params.attachmentId ?? '';
      const [row] = await db
        .select({ mime: agentMessageAttachments.mime, data: agentMessageAttachments.dataBase64 })
        .from(agentMessageAttachments)
        .where(
          and(
            eq(agentMessageAttachments.id, attachmentId),
            eq(agentMessageAttachments.orgId, orgId),
            eq(agentMessageAttachments.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.setHeader('Content-Type', row.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(Buffer.from(row.data, 'base64'));
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
        // The auto-undo watch: if the project has a live URL, watch it land in
        // the background — a confirmed break reverts this exact commit and the
        // thread hears about it either way. No live URL → nothing to watch,
        // said nowhere: the ship message already told the owner the watcher's
        // scope honestly.
        if (resolved.liveUrl) {
          const { commit } = out;
          void observeAfterShip(db, orgId, projectId, resolved.cfg, commit, resolved.liveUrl).catch((err) =>
            console.error(`post-ship watch failed for ${orgId}/${projectId}:`, err),
          );
        }
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

  // Put it online: create the database and hosting, mint an address, wait for
  // the first build. Minutes long, so it runs in the background and narrates
  // itself onto the thread the page already polls.
  router.post(
    '/api/projects/:projectId/workshop/golive',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      void (deps.goLive ?? goLive)(db, orgId, projectId).catch((err) => {
        console.error(`go-live failed for ${orgId}/${projectId}:`, err);
      });
      res.status(202).json({ started: true });
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
