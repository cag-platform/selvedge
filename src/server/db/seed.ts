import { db, sql } from './client.js';
import { orgs } from './schema/index.js';
import { loadWorkedExamplePacks } from '../packs/workedExamples.js';
import { createPack, getPack } from '../packs/store.js';

/**
 * Loads the eight worked-example packs (docs/worked-examples.md) under
 * Greg's dogfooding org. SEED_ORG_ID should be the real Clerk org id in
 * any environment where Clerk is wired up; it defaults to a placeholder so
 * `npm run db:seed` is runnable against a fresh dev database immediately.
 */
async function main() {
  const orgId = process.env.SEED_ORG_ID ?? 'org_greg_dogfood';

  await db.insert(orgs).values({ orgId }).onConflictDoNothing();

  const examplePacks = loadWorkedExamplePacks();
  console.log(`Loaded ${examplePacks.length} worked-example packs from docs/worked-examples.md`);

  for (const pack of examplePacks) {
    const existing = await getPack(db, orgId, pack.identity.project_id);
    if (existing) {
      console.log(`  skip  ${pack.identity.project_id} (already seeded)`);
      continue;
    }
    await createPack(db, orgId, pack);
    console.log(`  seed  ${pack.identity.project_id} — ${pack.identity.name}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
