import { pgTable, text, boolean, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * WHAT A PREVIEW NEEDS TO RUN THAT THE REPOSITORY DOESN'T CONTAIN.
 *
 * An app built anywhere real expects things a fresh checkout has none of: a
 * database, an API key, a signing secret. Apps scaffolded inside Selvedge tend
 * to be simple enough not to need any yet, which is why this only became
 * obvious when somebody imported a repository that had been running in
 * production for months and the preview died on `ECONNREFUSED 5432`.
 *
 * THE VALUES ARE ENCRYPTED AND NEVER COME BACK OUT. Same posture as connector
 * credentials, same crypto, same reason: this is a place customers will put
 * real secrets, so the plaintext is never a column, never logged, never
 * returned by an API, and only decrypted at the moment it is handed to a
 * sandbox. What the UI can read is the NAMES — enough to say "STRIPE_SECRET_KEY
 * is set" without ever showing what it is set to.
 *
 * AND THEY NEVER TOUCH THE REPOSITORY. The sandbox receives them as a file
 * outside the checkout, sourced by the start command. Writing a .env into
 * /workspace/app would put a customer's secrets one `git add -A` away from
 * their own public history — the same reason this codebase refuses to write a
 * CLAUDE.md into a customer repo.
 *
 * One row per (org, project), because a preview environment belongs to a
 * project the way a context pack does.
 */
export const previewEnv = pgTable(
  'preview_env',
  {
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    /**
     * The whole environment as KEY=VALUE lines, AES-256-GCM, bound to
     * (org, `preview-env:project`) as additional authenticated data — so a blob
     * lifted from one project's row cannot be decrypted as another's.
     *
     * Stored as one blob rather than a row per variable because it is written
     * and read as a set: a partial environment is not a smaller environment,
     * it is a broken one.
     */
    valueEnc: text('value_enc'),
    /**
     * The variable NAMES, in order, so a screen can show what is set without
     * decrypting anything. Kept alongside rather than derived, because reading
     * the names should never require the key that reads the values.
     */
    keyNames: text('key_names').array().notNull().default([]),
    /**
     * Start a throwaway Postgres in the sandbox and point DATABASE_URL at it.
     *
     * Off by default and deliberately so: most projects do not need it, it
     * costs a minute of build time on first start, and a database nobody asked
     * for is a surprise. The preview offers it when a start actually fails on a
     * refused database port — a suggestion made at the moment it is relevant
     * beats a checkbox nobody reads.
     *
     * Sandbox-only. It is created empty, it dies with the sandbox, and it never
     * touches a real database of the owner's.
     */
    wantsDatabase: boolean('wants_database').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.projectId] })],
);
