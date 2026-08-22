import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ConnectorKind } from '../../shared/types/event.js';
import type { SourceRole } from '../../shared/types/pack.js';
import { events, ignoredSources } from '../db/schema/index.js';
import { createPack, listPacks, updateMachineSections } from '../packs/store.js';
import { scaffoldPackFromRepo } from '../packs/scaffold.js';

function defaultRoleFor(connector: ConnectorKind): SourceRole {
  return connector === 'github' || connector === 'replit' ? 'source_of_truth' : 'auxiliary';
}

/** A GitHub source_account_id IS the repo's full name — "owner/repo". */
const REPO_SHAPED = /^[^/\s]+\/[^/\s]+$/;

export function isRepo(connector: string, resourceId: string): boolean {
  return connector === 'github' && REPO_SHAPED.test(resourceId);
}

async function ignoredKeys(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ connector: ignoredSources.connector, resourceId: ignoredSources.resourceId })
    .from(ignoredSources)
    .where(eq(ignoredSources.orgId, orgId));
  return new Set(rows.map((r) => `${r.connector}:${r.resourceId}`));
}

export async function listUnsortedEvents(db: Db, orgId: string, limit = 50) {
  const ignored = await ignoredKeys(db, orgId);
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), isNull(events.projectId)))
    .orderBy(desc(events.occurredAt))
    .limit(limit);
  // Filtered here rather than in SQL because "ignored" is a small set and the
  // composite key doesn't lend itself to a clean NOT IN across two columns.
  return rows.filter((e) => !ignored.has(`${e.source}:${e.sourceAccountId}`));
}

/**
 * THE UNSORTED TRAY, AS THE OWNER SEES IT — one row per SOURCE, not per event.
 *
 * The tray used to show an opaque `source_account_id` and offer exactly one
 * answer: "this belongs to an existing project". For GitHub — the connector
 * that produces nearly all of them — that id IS the repository's full name,
 * so the tray already held the answer to "which repo is this?" and simply
 * never said so. And the most likely true answer, "that's a project I haven't
 * set up yet", had no button at all, so those rows sat in the tray forever.
 */
export type UnsortedSource = {
  connector: ConnectorKind;
  resourceId: string;
  /** What it is in the owner's world — a repo name, said as one. */
  label: string;
  isRepo: boolean;
  count: number;
  lastSeen: string;
};

export async function listUnsortedSources(db: Db, orgId: string, limit = 200): Promise<UnsortedSource[]> {
  const ignored = await ignoredKeys(db, orgId);
  const rows = await db
    .select({
      connector: events.source,
      resourceId: events.sourceAccountId,
      count: sql<number>`count(*)`,
      lastSeen: sql<string>`max(${events.occurredAt})`,
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), isNull(events.projectId)))
    .groupBy(events.source, events.sourceAccountId)
    .orderBy(desc(sql`max(${events.occurredAt})`))
    .limit(limit);

  return rows
    .filter((r) => !ignored.has(`${r.connector}:${r.resourceId}`))
    .map((r) => ({
      connector: r.connector as ConnectorKind,
      resourceId: r.resourceId,
      label: r.resourceId,
      isRepo: isRepo(r.connector, r.resourceId),
      count: Number(r.count),
      lastSeen: new Date(r.lastSeen).toISOString(),
    }));
}

export async function listIgnoredSources(db: Db, orgId: string) {
  const rows = await db
    .select()
    .from(ignoredSources)
    .where(eq(ignoredSources.orgId, orgId))
    .orderBy(desc(ignoredSources.createdAt));
  return rows.map((r) => ({
    connector: r.connector as ConnectorKind,
    resourceId: r.resourceId,
    label: r.resourceId,
    isRepo: isRepo(r.connector, r.resourceId),
  }));
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

/**
 * WATCH IT — the answer the tray never offered.
 *
 * "That's a project I haven't set up yet" is the most likely true answer for a
 * repo you own, and the only thing standing between the tray and a project was
 * a form asking for a name and a repo the tray already knew. So it makes the
 * project from what it already has: the repo's own name, mapped to the repo,
 * with everything that had been waiting assigned to it in the same breath.
 *
 * The pack is deliberately a starting point at `personal` stakes, not a guess
 * dressed as knowledge — the owner corrects it in About, and the ceiling that
 * governs spending stays the gentlest one until they do.
 */
export async function watchSource(
  db: Db,
  orgId: string,
  connector: ConnectorKind,
  resourceId: string,
): Promise<{ projectId: string; name: string; updatedCount: number }> {
  if (!isRepo(connector, resourceId)) {
    throw new Error('Only a GitHub repository can become a project on its own.');
  }
  const taken = new Set((await listPacks(db, orgId, { includeArchived: true })).map((p) => p.identity.project_id));
  const pack = scaffoldPackFromRepo(resourceId, taken);
  await createPack(db, orgId, pack);
  const { updatedCount } = await assignUnsortedSource(db, orgId, connector, resourceId, pack.identity.project_id);
  return { projectId: pack.identity.project_id, name: pack.identity.name, updatedCount };
}

/**
 * IGNORE — the third honest answer. Not everything that reaches Selvedge is
 * the owner's to care about, and a tray that can only say "file this" is a
 * tray that grows forever until it means nothing.
 *
 * Idempotent, and covers events that haven't arrived yet: asking twice about
 * something already dismissed is the failure this prevents.
 */
export async function ignoreSource(db: Db, orgId: string, connector: ConnectorKind, resourceId: string): Promise<void> {
  await db.insert(ignoredSources).values({ orgId, connector, resourceId }).onConflictDoNothing();
}

/** Undo, in one row's deletion — everything from that source comes back. */
export async function unignoreSource(db: Db, orgId: string, connector: ConnectorKind, resourceId: string): Promise<void> {
  await db
    .delete(ignoredSources)
    .where(
      and(
        eq(ignoredSources.orgId, orgId),
        eq(ignoredSources.connector, connector),
        eq(ignoredSources.resourceId, resourceId),
      ),
    );
}
