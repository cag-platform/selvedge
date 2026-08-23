import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createSubject, ensureSubject, listSubjects, renameSubject, setSubjectArchived } from '../../threads/subjects.js';
import { createSubjectThread } from '../../threads/store.js';
import { IDEAS_SUBJECT } from '../../../shared/types/thread.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Subjects — make one, rename it, put it away. There is nothing else to do to a
 * subject, which is the point of it.
 */
export function createSubjectsRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/subjects',
    asyncHandler(async (req, res) => {
      res.json({ subjects: await listSubjects(db, orgIdOf(req)) });
    }),
  );

  /**
   * START AN IDEA — a conversation about nothing in particular, yet.
   *
   * Deliberately NOT a new kind of thing. An idea is a plain conversation
   * under a subject called "Ideas", which is what a subject already is: a place
   * for work that isn't a codebase. A parallel "generic chat" belonging to
   * neither a project nor a subject would reintroduce the one state the rail
   * cannot render — a thread filed nowhere is reachable by name and findable by
   * nobody.
   *
   * So this is a front door, not a room. The subject is made on first use, the
   * way the import's "Claude history" is, and it starts on a TALKER — nothing
   * here can build yet, and starting an idea on Claude Code would be offering a
   * sandbox to a sentence.
   *
   * An idea that becomes a project LEAVES: `POST /threads/:id/build` files it
   * into the project it produced, and this list gets shorter. That is the
   * intended shape — a conversation lives in one place — and it means "Ideas"
   * empties as things succeed rather than accumulating everything that ever
   * worked.
   */
  router.post(
    '/api/ideas',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const subject = await ensureSubject(db, orgId, IDEAS_SUBJECT, 'Half-formed things, before they are anything.');
      const body = (req.body ?? {}) as { title?: unknown };
      const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined;
      const thread = await createSubjectThread(db, orgId, subject.id, title ? { title } : {});
      res.status(201).json({
        thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent },
        subject: { id: subject.id, name: subject.name },
      });
    }),
  );

  router.post(
    '/api/subjects',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        res.status(400).json({ error: 'a subject needs a name' });
        return;
      }
      const subject = await createSubject(db, orgIdOf(req), name, typeof body.description === 'string' ? body.description : undefined);
      res.status(201).json({ subject });
    }),
  );

  router.patch(
    '/api/subjects/:id',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const id = req.params.id ?? '';
      const body = (req.body ?? {}) as { name?: unknown; archived?: unknown };
      if (typeof body.name === 'string' && !(await renameSubject(db, orgId, id, body.name))) {
        res.status(400).json({ error: 'a subject needs a name' });
        return;
      }
      if (typeof body.archived === 'boolean' && !(await setSubjectArchived(db, orgId, id, body.archived))) {
        res.status(404).json({ error: 'no such subject' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
