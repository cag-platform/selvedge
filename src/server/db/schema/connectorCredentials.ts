import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Connector credentials — the most valuable rows in the database. One row per
 * (org, provider): the customer's model key/subscription token (the "fuel"
 * connector), and later host tokens (Railway, Vercel) and database OAuth
 * tokens.
 *
 * The secret itself lives ONLY in `value_enc`, AES-256-GCM ciphertext produced
 * by connectors/credentials/crypto.ts — keyed from a dedicated CREDENTIALS_KEY,
 * per-org, and bound to (org, provider) as additional authenticated data. The
 * plaintext is never a column, never logged, and only ever decrypted at the
 * moment of use.
 *
 * `label` and `last4` exist so the UI can show *which* key is connected
 * ("Anthropic ····a03f") and when, without ever reading the secret back — the
 * same posture as the source platforms we criticise for write-only vaults,
 * except here it is a deliberate safety property, not an export obstacle:
 * revocation is one delete, and re-connecting is the recovery path.
 *
 * `status` tracks the credential's health so the brief can say "your Claude
 * connection stopped working" in plain words rather than the app silently
 * failing — 'active' | 'invalid' (last use was rejected) | 'revoked'.
 */
export const connectorCredentials = pgTable(
  'connector_credentials',
  {
    orgId: text('org_id').notNull(),
    // 'anthropic' | 'openai' | 'gemini' | 'kimi' (fuel) | 'railway' | 'vercel' | 'supabase' | ...
    provider: text('provider').notNull(),
    // 'subscription' | 'api_key' — for fuel, which kind of access this is.
    kind: text('kind').notNull().default('api_key'),
    valueEnc: text('value_enc').notNull(),
    // Display-only, never the secret: a human label and the last 4 chars.
    label: text('label'),
    last4: text('last4'),
    status: text('status').notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.provider] })],
);
