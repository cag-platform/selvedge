import { Router, type Request } from 'express';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { subjects } from '../../db/schema/index.js';
import { ensureSubject } from '../../threads/subjects.js';
import { getPack } from '../../packs/store.js';
import { importSummary, readExport } from '../../import/consumer/read.js';
import { fileConversations, type Target } from '../../import/consumer/store.js';
import { VENDOR_NAMES } from '../../import/consumer/types.js';
import { reviewFiling } from '../../import/filing.js';

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
/**
 * The way through when an archive is over that. A ChatGPT export is mostly
 * images — every DALL·E render, everything anyone ever uploaded — and only
 * `conversations.json` is ever read, so a history that will not fit as an
 * archive fits comfortably as the one file. Said here as well as in the
 * reader, because this is the limit a large export hits FIRST.
 */
const JUST_THE_FILE =
  'Unzip it and upload just conversations.json — that is the only file I read, and it is a small part of what the download contains.';
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
            ? `That export is bigger than ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB, which is more than I can take in one go. ${JUST_THE_FILE}`
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
      // NAMING A PLACE IS OPTIONAL, and not naming one is the ordinary case.
      //
      // This used to demand a project or a subject before it would take the
      // file at all, which put a filing decision in front of the upload and
      // then tied a whole account's history to whichever project happened to
      // be picked. A year of thinking about six different things is not "about
      // Loom", and once it was filed there it read as though it were.
      //
      // So the default is the account: the chats belong to no project, and any
      // conversation can reach them by name.
      if (projectId !== null && subjectId !== null) {
        res.status(400).json({ error: 'Pick one place for these, or none at all.' });
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

      // Archive or bare .json — the reader tells them apart from the bytes,
      // because the file extension is the least reliable thing about an upload.
      // multer's buffer IS a Uint8Array, so the copy this used to make was a
      // second full-size allocation of a file that can run to hundreds of
      // megabytes — the one place in the request where doubling the memory
      // bought nothing at all.
      const read = readExport(file.buffer);
      if (!read.ok) {
        res.status(400).json({ error: read.error });
        return;
      }

      /**
       * With nowhere named, the vendor's own name IS the place: "ChatGPT
       * history", made once and reused on every later import.
       *
       * A subject rather than nothing, because a thread belonging to neither a
       * project nor a subject is filed nowhere and the rail cannot show it —
       * reachable by name and findable by nobody, which is worse than being in
       * the wrong place. A subject is somewhere for work that isn't a codebase,
       * which is exactly what a year of old chats is.
       */
      const madeHome = projectId || subjectId ? null : await ensureSubject(db, orgId, `${VENDOR_NAMES[read.vendor]} history`);
      const home = projectId ? ({ projectId } as Target) : ({ subjectId: subjectId ?? madeHome!.id } as Target);
      const filed = await fileConversations(db, orgId, home, read.vendor, read.conversations);

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
        // WHERE THEY WENT. An import that files somewhere the owner did not
        // name has to say where, or the chats are simply gone as far as they
        // can tell.
        ...(madeHome ? { filed_under: madeHome.name } : {}),
        summary: importSummary(read.vendor, filed.filed, read.unreadable.length, madeHome?.name),
      });
    }),
  );

  /**
   * WHERE THE OLD CHATS LOOK LIKE THEY BELONG.
   *
   * The step that was missing. An import filed everything under one subject
   * and stopped there, which made "bring your history and continue building"
   * true up to the word "continue" — a year of work about your projects,
   * sitting in a pile next to your projects, with no way to join the two.
   *
   * Suggestions only. Nothing here writes, and every row carries the words it
   * matched on so the owner is reading evidence rather than trusting a score.
   */
  router.get(
    '/api/import/filing',
    asyncHandler(async (req, res) => {
      const review = await reviewFiling(db, orgIdOf(req));
      res.json({
        unfiled: review.unfiled,
        ambiguous: review.ambiguous,
        suggestions: review.suggestions.map((s) => ({
          thread_id: s.threadId,
          title: s.title,
          at: s.at,
          message_count: s.messageCount,
          project_id: s.projectId,
          project_name: s.projectName,
          because: s.because,
          matched_in: s.matchedIn,
        })),
        // WHAT THIS CANNOT DO, said next to what it can. Most of a personal
        // history is not about a codebase — it is holidays, health, half-formed
        // ideas — and a tool that implied every conversation ought to end up in
        // a project would be inventing work rather than saving it.
        note:
          review.unfiled === 0
            ? null
            : 'Only conversations that name a project are suggested. The rest stay where they are — most of a history is not about a codebase, and that is not a filing error.',
      });
    }),
  );

  return router;
}
