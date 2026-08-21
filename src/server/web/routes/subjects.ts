import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createSubject, listSubjects, renameSubject, setSubjectArchived } from '../../threads/subjects.js';

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
