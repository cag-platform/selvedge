import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { assignUnsortedSource, listUnsortedEvents } from '../../resolution/unsortedTray.js';
import type { ConnectorKind } from '../../../shared/types/event.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Unsorted tray (deliverable 4/8): unmapped events + one-tap assignment. */
export function createTrayRouter(db: Db) {
  const router = Router();

  router.get('/api/tray', async (req, res) => {
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
  });

  router.post('/api/tray/assign', async (req, res) => {
    const { connector, resource_id: resourceId, project_id: projectId } = req.body as {
      connector: ConnectorKind;
      resource_id: string;
      project_id: string;
    };
    if (!connector || !resourceId || !projectId) {
      res.status(400).json({ error: 'connector, resource_id, and project_id are required' });
      return;
    }
    const result = await assignUnsortedSource(db, orgIdOf(req), connector, resourceId, projectId);
    res.json(result);
  });

  return router;
}
