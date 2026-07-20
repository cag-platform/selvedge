import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ConnectorKind } from '../../shared/types/event.js';
import type { SourceRole } from '../../shared/types/pack.js';
import { events } from '../db/schema/index.js';
import { updateMachineSections } from '../packs/store.js';

function defaultRoleFor(connector: ConnectorKind): SourceRole {
  return connector === 'github' || connector === 'replit' ? 'source_of_truth' : 'auxiliary';
}

export async function listUnsortedEvents(db: Db, orgId: string, limit = 50) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), isNull(events.projectId)))
    .orderBy(desc(events.occurredAt))
    .limit(limit);
}

/**
 * One-tap assignment (deliverable 4): maps every currently-unsorted event
 * from this (connector, resource_id) to `projectId`, and writes the
 * mapping into the pack's topology.sources so future events from this
 * source resolve automatically — "it never asks twice".
 */
export async function assignUnsortedSource(
  db: Db,
  orgId: string,
  connector: ConnectorKind,
  resourceId: string,
  projectId: string,
): Promise<{ updatedCount: number }> {
  await updateMachineSections(db, orgId, projectId, {
    addSources: [{ connector, resource_id: resourceId, role: defaultRoleFor(connector) }],
  });

  const updated = await db
    .update(events)
    .set({ projectId })
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.source, connector),
        eq(events.sourceAccountId, resourceId),
        isNull(events.projectId),
      ),
    )
    .returning({ id: events.id });

  return { updatedCount: updated.length };
}
