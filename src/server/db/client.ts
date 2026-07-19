import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
