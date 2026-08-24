import { Router, type Request } from 'express';
import multer from 'multer';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { readAppZip } from '../../import/replitApp.js';
import { createProject, type CreateDeps } from '../../packs/create.js';
import { refuse } from '../middleware/limit.js';
import { ensureWorkshopThread } from '../../threads/store.js';
import { getPack } from '../../packs/store.js';
import { GithubError } from '../../connectors/github/newRepo.js';
import { pushFilesToRepo, type PushResult } from '../../connectors/github/pushFiles.js';

/**
 * IMPORT FROM REPLIT — the migration door.
 *
 * Not a chat import: the thing coming through is a working APP, on its way
 * from a workspace somebody rents to a repo they own. Replit's own export is
 * the zip download, so the flow is: zip in → workspace junk filtered and named
 * → a repo minted under the owner's GitHub → the files landed as one commit →
 * a Selvedge project around it, workshop open. The Repl's agent history does
 * not come along, because Replit offers no export of it, and scraping what a
 * vendor won't export is a feature that breaks the week they change a div.
 *
 * TWO MODES, ONE DOOR. With a `name`, it creates the project (plan gate first,
 * repo before pack — createProject's ordering, reused not restated). With a
 * `project_id`, it pushes into a project that already exists — which is both
 * the retry path when a first attempt made the project and then failed to
 * land the files, and the "bring the real code into the repo I already made"
 * path. Pushing layers a commit on top; it never rewrites what is there.
 *
 * THE SECRETS DO NOT RIDE IN THE ZIP. A Repl's env is in Replit's vault, not
 * its filesystem, so nothing here handles them — the response points at the
 * preview environment box, which is the screen built for exactly that paste.
 */

const MAX_ZIP_BYTES = 200 * 1024 * 1024;

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export type ImportReplitDeps = CreateDeps & {
  push?: typeof pushFilesToRepo;
};

export function createImportReplitRouter(db: Db, deps: ImportReplitDeps = {}) {
  const router = Router();
  const push = deps.push ?? pushFilesToRepo;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } }).single('file');

  router.post(
    '/api/import/replit',
    (req, res, next) => {
      upload(req, res, (err: unknown) => {
        if (!err) return next();
        const tooBig = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
        res.status(400).json({
          error: tooBig
            ? `that zip is over ${MAX_ZIP_BYTES / 1024 / 1024}MB. Most of a Repl zip is usually node_modules — delete it from the Repl before downloading, and the export shrinks to the app itself.`
            : "I couldn't read that upload.",
        });
      });
    },
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const file = (req as Request & { file?: { buffer?: Buffer } }).file;
      if (!file?.buffer) {
        res.status(400).json({ error: 'No file came with that — download the Repl as a zip and choose it here.' });
        return;
      }

      // The zip is validated BEFORE anything is created, so a refusal here
      // costs nothing and a plan-limit refusal never follows a minted repo.
      const read = readAppZip(file.buffer);
      if (!read.ok) {
        res.status(400).json({ error: read.error });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const existingId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      if ((name === '') === (existingId === '')) {
        res.status(400).json({ error: 'Say what to call it, or which project it goes into — one or the other.' });
        return;
      }

      let projectId: string;
      let repo: string;
      if (existingId) {
        const pack = await getPack(db, orgId, existingId);
        if (!pack) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        const source = pack.topology.sources.find((s) => s.connector === 'github');
        if (!source) {
          res.status(409).json({ error: 'that project has no GitHub repo to push into.' });
          return;
        }
        projectId = existingId;
        repo = source.resource_id;
      } else {
        const made = await createProject(db, orgId, { name, repo: null, tier: 'personal' }, deps);
        if (!made.ok) {
          if (made.kind === 'limit') {
            refuse(res, made.allowance);
            return;
          }
          res.status(made.status).json({ error: made.error, ...(made.details ? { details: made.details } : {}) });
          return;
        }
        projectId = made.pack.identity.project_id;
        repo = made.pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? '';
      }

      let pushed: PushResult;
      try {
        pushed = await push(repo, read.files, 'Imported from Replit');
      } catch (err) {
        if (err instanceof GithubError) {
          // The project exists and the files did not land — said exactly, with
          // the way through, because "it failed" after a repo was minted is
          // the kind of half-state that otherwise costs an hour of confusion.
          res.status(502).json({
            error: `The project was created but the files did not land: ${err.message}. Upload the same zip again into "${projectId}" — pushing layers, it never duplicates the project.`,
            project_id: projectId,
          });
          return;
        }
        throw err;
      }

      const thread = await ensureWorkshopThread(db, orgId, projectId);
      res.json({
        project_id: projectId,
        thread_id: thread.id,
        repo,
        files: pushed.files,
        // What was left behind, by name — "your Repl is in" must never quietly
        // mean "except the parts I decided about".
        skipped: read.skipped,
        skipped_count: read.skippedCount,
        summary:
          `${pushed.files} files landed in ${repo}` +
          (read.skippedCount > 0 ? ` — workspace junk left behind: ${read.skipped.join(', ')} (${read.skippedCount} files)` : '') +
          '. Secrets do not travel in a zip: paste the .env into the preview environment when the preview asks.',
      });
    }),
  );

  return router;
}
