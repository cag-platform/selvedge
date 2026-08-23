import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/server/db/schema/index.js';

/**
 * THE TENANCY CONTRACT, ENFORCED STRUCTURALLY.
 *
 * Every table carries `org_id`. This test walks the real Drizzle schema
 * objects — not the source text — so it cannot be fooled by formatting, and
 * it fails closed: a new table nobody thought about is a FAILURE, not a pass.
 *
 * Why this exists as a test rather than a convention: Toile contributes
 * roughly ten tables to this codebase (health checks, health events, build
 * runs, businesses, secrets, provider credentials…) and every one of them was
 * written for a single-user product with no tenant column anywhere. A
 * convention would catch nine of them. This catches the tenth, which is the
 * one that leaks.
 *
 * If you are here because this test failed: add `orgId` to your table. If the
 * table genuinely must be global, add it to GLOBAL_TABLES below with a reason
 * a reviewer can weigh — that makes the exception a deliberate, reviewed diff
 * rather than an omission.
 */
const GLOBAL_TABLES: Record<string, string> = {
  narration_library:
    'Deliberately cross-org: one graduated phrasing serves every tenant, which is the point of a shared library. ' +
    'Per-org usage is recorded in narration_library_uses, which IS scoped. Rows store a {project} slot rather than ' +
    'any customer name or content, so nothing tenant-identifying lives here.',
  stripe_events:
    "Stripe's own event ids, kept only so a retried webhook cannot be applied twice. Stripe assigns them globally " +
    'and sends them before we know whose org an event belongs to — the handler resolves the org FROM the event, so ' +
    'requiring org_id here would mean writing the dedup row after the work it is meant to guard. Rows hold an ' +
    'opaque id and an event type; no customer data, and nothing is ever read back per tenant.',
};

function allTables(): Array<{ name: string; columns: string[] }> {
  const out: Array<{ name: string; columns: string[] }> = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    out.push({
      name: getTableName(value as never),
      columns: Object.keys(getTableColumns(value as never)),
    });
  }
  return out;
}

describe('tenancy contract', () => {
  it('finds the schema (guards against this whole suite silently testing nothing)', () => {
    const tables = allTables();
    expect(tables.length).toBeGreaterThan(5);
  });

  it('every table is org-scoped, or is a named and justified exception', () => {
    const offenders: string[] = [];

    for (const { name, columns } of allTables()) {
      if (name === 'orgs') continue; // the tenant table itself; org_id is its primary key
      const scoped = columns.includes('orgId');
      const excused = name in GLOBAL_TABLES;

      if (!scoped && !excused) {
        offenders.push(
          `  ${name} — has no org_id and is not in GLOBAL_TABLES.\n` +
            `    Columns: ${columns.join(', ')}\n` +
            `    Add orgId, or add "${name}" to GLOBAL_TABLES with a reason.`,
        );
      }
      // A table cannot be both scoped and excused — that means someone added
      // org_id later and forgot to remove the exception, leaving a stale
      // licence to skip scoping that the next table might inherit by copy.
      if (scoped && excused) {
        offenders.push(`  ${name} — is org-scoped but still listed in GLOBAL_TABLES. Remove the stale exception.`);
      }
    }

    expect(offenders.join('\n'), `Tenancy contract violations:\n${offenders.join('\n')}`).toBe('');
  });

  it('every exception carries a real reason, not a placeholder', () => {
    for (const [table, reason] of Object.entries(GLOBAL_TABLES)) {
      expect(reason.length, `${table}'s exception needs an explanation a reviewer can weigh`).toBeGreaterThan(60);
    }
  });

  it('the exception list stays small enough to read', () => {
    // Not a style rule. Every entry here is a table where cross-tenant leakage
    // cannot be caught by the scoping check, so the list is the manual review
    // burden. If it grows past a handful, the contract has stopped meaning
    // anything and needs rethinking rather than extending.
    expect(Object.keys(GLOBAL_TABLES).length).toBeLessThanOrEqual(3);
  });
});
