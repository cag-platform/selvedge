import { Router, type Request } from 'express';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { subjects } from '../../db/schema/index.js';
import { getPack } from '../../packs/store.js';
import { importSummary, readExportZip } from '../../import/consumer/read.js';
import { fileConversations, type Target } from '../../import/consumer/store.js';
import { VENDOR_NAMES } from '../../import/consumer/types.js';

/**
 * CONSUMER-HISTORY IMPORT — one endpoint, one file, one time.
 *
 * This is deliberately not a connector. Selvedge does not and will not watch a
 * consumer chat app: live capture of ChatGPT, Claude or Gemini is refused
 * permanently (INBOX-LOOP-BRIEF §9). What this does is accept the export the
 * vendor already gives you, once, and file it where you say.
 *
 * The response says what came in AND what could not be read, in the same
 * breath and at the same volume. An import that reports 1,204 successes and
 * silently drops 300 entries is the same shape of lie as a confidently wrong
 * all-clear, and it is not available here.
 */

const MAX_ZIP_BYTES = 500 * 1024 * 1024;
/** One import, one go. Beyond this the response itself becomes unreadable. */
const MAX_UNREADABLE_LISTED = 50;

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export function createImportHistoryRouter(db: Db) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } }).single('file');

  router.post(
    '/api/import/history',
    (req, res, next) => {
      upload(req, res, (err: unknown) => {
        if (!err) return next();
        const tooBig = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
        res.status(400).json({
          error: tooBig
            ? `That export is bigger than ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB, which is more than I can take in one go.`
            : "I couldn't read that upload.",
        });
      });
    },
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const file = (req as Request & { file?: { buffer?: Buffer } }).file;
      if (!file?.buffer) {
        res.status(400).json({ error: 'No file came with that — choose the export ZIP the vendor gave you.' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectId = typeof body.project_id === 'string' && body.project_id !== '' ? body.project_id : null;
      const subjectId = typeof body.subject_id === 'string' && body.subject_id !== '' ? body.subject_id : null;
      if ((projectId === null) === (subjectId === null)) {
        res.status(400).json({ error: 'Say where these should go: a project, or a subject.' });
        return;
      }

      // Both targets are checked against this org before a single row is
      // written — an import is the last place to discover a scoping mistake.
      if (projectId && !(await getPack(db, orgId, projectId))) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      if (subjectId) {
        const [row] = await db
          .select({ id: subjects.id })
          .from(subjects)
          .where(and(eq(subjects.orgId, orgId), eq(subjects.id, subjectId)))
          .limit(1);
        if (!row) {
          res.status(404).json({ error: 'no such subject' });
          return;
        }
      }

      const read = readExportZip(new Uint8Array(file.buffer));
      if (!read.ok) {
        res.status(400).json({ error: read.error });
        return;
      }

      const target = (projectId ? { projectId } : { subjectId: subjectId! }) as Target;
      const filed = await fileConversations(db, orgId, target, read.vendor, read.conversations);

      res.status(201).json({
        vendor: read.vendor,
        vendor_name: VENDOR_NAMES[read.vendor],
        file: read.file,
        filed: filed.filed,
        already_had: filed.alreadyHad,
        // Never a bare success count.
        unreadable_count: read.unreadable.length,
        unreadable: read.unreadable.slice(0, MAX_UNREADABLE_LISTED),
        unreadable_truncated: Math.max(0, read.unreadable.length - MAX_UNREADABLE_LISTED),
        limitations: read.limitations,
        summary: importSummary(read.vendor, filed.filed, read.unreadable.length),
      });
    }),
  );

  return router;
}
