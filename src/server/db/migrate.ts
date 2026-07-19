import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { ensureCurrentPartitions } from './partitions.js';
import { requireDatabaseUrl } from './connectionString.js';

async function main() {
  const connectionString = requireDatabaseUrl();

  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/server/db/migrations' });

  console.log('Ensuring current + next month event partitions exist...');
  await ensureCurrentPartitions(db);

  await sql.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
