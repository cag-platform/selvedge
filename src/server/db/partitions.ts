import { sql } from 'drizzle-orm';

/** Minimal shape both the postgres-js and pglite drizzle instances satisfy. */
type Executor = { execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown> };

/**
 * Creates the `events` partition for a given month if it doesn't already
 * exist. Idempotent — safe to call on every deploy/cron tick. Call with the
 * current month and next month so writes never fall through to the
 * `events_default` catch-all in steady state.
 */
export async function ensureMonthPartition(db: Executor, forDate: Date): Promise<void> {
  const year = forDate.getUTCFullYear();
  const month = forDate.getUTCMonth(); // 0-indexed
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const partitionName = `events_y${year}m${String(month + 1).padStart(2, '0')}`;

  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF "events" ` +
        `FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
    ),
  );
}

/** Ensures the current and next month's partitions exist. */
export async function ensureCurrentPartitions(db: Executor, now: Date = new Date()): Promise<void> {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await ensureMonthPartition(db, now);
  await ensureMonthPartition(db, nextMonth);
}
