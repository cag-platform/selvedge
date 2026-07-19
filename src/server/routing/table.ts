import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { RoutingRow, RoutingTable } from './types.js';

// Loaded via fs (not a JSON import) so dev (tsx), the compiled server build,
// and vitest all resolve the same on-disk file without import-attribute
// syntax differences between toolchains.
const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config/routing-table.json',
);

let cached: RoutingTable | null = null;

export function loadRoutingTable(): RoutingTable {
  if (!cached) {
    cached = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as RoutingTable;
  }
  return cached;
}

export function findRow(eventType: string): RoutingRow {
  const table = loadRoutingTable();
  const row = table.rows.find((r) => r.event_type === eventType);
  if (!row) {
    throw new Error(`No routing-table.json row for event_type "${eventType}"`);
  }
  return row;
}

export function findRowById(id: string): RoutingRow {
  const table = loadRoutingTable();
  const row = table.rows.find((r) => r.id === id);
  if (!row) {
    throw new Error(`No routing-table.json row with id "${id}"`);
  }
  return row;
}
