import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * In-flight OAuth handshakes — the few seconds between sending an owner to a
 * provider and them coming back with a code.
 *
 * Deliberately a table rather than the in-process Map the GitHub setup router
 * uses. That Map works only because a browser redirect happens to come back to
 * the same process; it does not survive a redeploy, and it does not survive a
 * second replica, in which case the callback lands on an instance that has
 * never heard of the state and the owner sees "please start again" through no
 * fault of their own. PKCE makes that worse: the verifier is generated at
 * /start and is REQUIRED at /callback, so losing it doesn't just lose context,
 * it makes the exchange impossible.
 *
 * Rows are consumed on use (one-time, like the Map's delete) and swept on age,
 * so nothing accumulates. The verifier is not a credential — it is worthless
 * without the matching authorization code, which is why this table does not go
 * through the vault.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    /** The opaque `state` parameter; unguessable, and the primary key so it is single-use by construction. */
    state: text('state').primaryKey(),
    orgId: text('org_id').notNull(),
    /** Which handshake this is — 'railway', later 'github'. */
    provider: text('provider').notNull(),
    /** The PKCE code verifier this handshake must present at the token exchange. */
    verifier: text('verifier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_states_created_idx').on(t.createdAt)],
);
