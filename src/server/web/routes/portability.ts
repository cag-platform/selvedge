import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { exportBundle, importBundle, type ExportBundle } from '../../memory/portability.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { operatorOnly } from '../middleware/operatorOnly.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * PORTABILITY — take your whole context out, and put it back.
 *
 * Being able to leave is what makes people stay, so the export is a button on
 * a page. The restore is NOT, and that asymmetry is deliberate rather than
 * unfinished: exporting is harmless and reassuring, while restoring MERGES a
 * bundle into a live account. A button beside "Export my context" saying
 * "Import my context" would dress a much more dangerous action in identical
 * clothes, and somebody would find out which was which afterwards.
 *
 * So restore is an operator endpoint. It is real, it is tested, and it is
 * reached deliberately — not offered to anyone passing.
 *
 * IT IS ALSO NOT THE HISTORY IMPORT. `/api/import/history` takes a ChatGPT,
 * Claude or Gemini export and has a whole screen; this takes a Selvedge bundle
 * and puts an account back. Two unrelated features both called "import" was a
 * trap for whoever touched this next, which is why this one is named for what
 * it does.
 */
export function createPortabilityRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/export',
    asyncHandler(async (req, res) => {
      const bundle = await exportBundle(db, orgIdOf(req));
      res.setHeader('Content-Disposition', 'attachment; filename="selvedge-context.json"');
      res.json(bundle);
    }),
  );

  // Restore merges a supplied bundle into a live account. Its own header called
  // it an operator endpoint; now it actually is one (fails closed on an empty
  // operator allowlist), so a member can't silently graft fabricated history in.
  router.post(
    '/api/context/restore',
    operatorOnly(),
    asyncHandler(async (req, res) => {
      const bundle = req.body as ExportBundle;
      if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.packs)) {
        res.status(400).json({ error: 'body must be a Selvedge export bundle with a packs array' });
        return;
      }
      try {
        const result = await importBundle(db, orgIdOf(req), bundle);
        res.json(result);
      } catch (err) {
        // The input is attacker-controlled, so a raw Drizzle/Postgres error
        // here would disclose table/column/constraint names. Log the detail
        // server-side; hand the caller a fixed line.
        console.error('[context/restore] import failed:', err);
        res.status(422).json({ error: 'that import could not be applied — check the bundle and try again' });
      }
    }),
  );

  return router;
}
