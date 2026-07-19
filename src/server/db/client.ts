import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';
import { requireDatabaseUrl } from './connectionString.js';

const connectionString = requireDatabaseUrl();

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
