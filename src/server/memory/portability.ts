import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrations, narrationLibrary, packs } from '../db/schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { assertValidPack } from '../packs/validate.js';
import type { NarrationOutput } from '../narration/types.js';

export const EXPORT_VERSION = '1';

export type ExportBundle = {
  selvedge_export_version: string;
  exported_at: string;
  org_id: string;
  packs: ContextPack[];
  /** The graduated meanings this org has actually seen — the learned dictionary. */
  learned_library: Array<{ fingerprint: string; plain: string }>;
};

/**
 * The full, portable context (Ironclad 1, part C). Being able to *leave*
 * increases trust enough to make people *stay*, and it's the honest anti-lock-
 * in posture that fits the independent-auditor position. Everything here is the
 * user's own data: their packs (identity/stakes/voice + learned baselines,
 * glossary, capability gaps, trust, state) and the graduated error meanings
 * Selvedge has seen on their stack.
 */
export async function exportBundle(db: Db, orgId: string, now: Date = new Date()): Promise<ExportBundle> {
  const packRows = await db.select().from(packs).where(eq(packs.orgId, orgId));
  const packList = packRows.map((r) => r.pack as ContextPack);

  const narrRows = await db.select({ meta: narrations.meta }).from(narrations).where(eq(narrations.orgId, orgId));
  const fps = new Set<string>();
  for (const r of narrRows) {
    const fp = (r.meta as { fingerprint?: string } | null)?.fingerprint;
    if (fp) fps.add(fp);
  }
  const fpList = [...fps];
  const libRows = fpList.length ? await db.select().from(narrationLibrary).where(inArray(narrationLibrary.fingerprint, fpList)) : [];
  const learned = libRows
    .filter((l) => l.status === 'graduated')
    .map((l) => ({ fingerprint: l.fingerprint, plain: (l.phrasing as NarrationOutput).fragment }));

  return {
    selvedge_export_version: EXPORT_VERSION,
    exported_at: now.toISOString(),
    org_id: orgId,
    packs: packList,
    learned_library: learned,
  };
}

export type ImportResult = { restored: number; skipped: number };

/**
 * Restore an exported bundle into an org. Packs are the org-owned data, so we
 * validate each and upsert it (a re-import of your own export is idempotent).
 * The learned_library is global infrastructure shared across orgs, not owned
 * data, so it is NOT re-seeded on import — it's included in the export for the
 * user's records and re-learns naturally.
 */
export async function importBundle(db: Db, orgId: string, bundle: ExportBundle): Promise<ImportResult> {
  if (bundle.selvedge_export_version !== EXPORT_VERSION) {
    throw new Error(`unsupported export version "${bundle.selvedge_export_version}"`);
  }
  let restored = 0;
  let skipped = 0;
  for (const pack of bundle.packs ?? []) {
    try {
      assertValidPack(pack);
    } catch {
      skipped++;
      continue;
    }
    await db
      .insert(packs)
      .values({ orgId, projectId: pack.identity.project_id, pack, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [packs.orgId, packs.projectId],
        set: { pack, updatedAt: new Date() },
      });
    restored++;
  }
  return { restored, skipped };
}
