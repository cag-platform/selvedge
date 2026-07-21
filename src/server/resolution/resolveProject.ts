import type { Db } from '../db/client.js';
import type { ConnectorKind } from '../../shared/types/event.js';
import { listPacks } from '../packs/store.js';

/**
 * Maps a connector + resource_id to a project_id via pack topology.sources.
 * Linear scan over the org's packs — fine at Phase 1 scale (a handful of
 * projects per org); an indexed lookup table is the obvious upgrade once
 * an org has dozens of projects.
 */
export async function resolveProjectId(db: Db, orgId: string, connector: ConnectorKind, resourceId: string): Promise<string | null> {
  // Include archived packs: a deleted project keeps its (tombstoned) pack, and
  // we must still resolve its repo so the backfill treats it as spoken-for and
  // doesn't re-scaffold a fresh copy (see deletePack).
  const packs = await listPacks(db, orgId, { includeArchived: true });
  for (const pack of packs) {
    const match = pack.topology.sources.some((s) => s.connector === connector && s.resource_id === resourceId);
    if (match) return pack.identity.project_id;
  }
  return null;
}
