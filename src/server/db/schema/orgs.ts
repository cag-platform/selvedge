import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * One row per Clerk organization. Created lazily on first authenticated
 * request (see web/middleware/orgScope.ts). Carries org-level settings that
 * don't belong on any single project pack, e.g. the timezone the daily
 * digest job uses to compute "local 7:00am".
 */
export const orgs = pgTable('orgs', {
  orgId: text('org_id').primaryKey(),
  timezone: text('timezone').notNull().default('UTC'),
  // 'default' = never set (auto-detect may overwrite) | 'auto' = detected
  // from a signed-in browser | 'user' = explicitly chosen, never overwritten.
  timezoneSource: text('timezone_source').notNull().default('default'),
  // The CARE TIER: how much of Selvedge's own model budget this org may spend
  // per day (llm/budget.ts). 'trial' | 'care' | 'studio'.
  //
  // NOT the subscription. `subscriptions.plan` is 'free' | 'pro' | 'team' and
  // says what the customer bought; this says how much watching we do on our own
  // fuel. Two axes, same word, no derivation between them — read
  // server/billing/entitlements.ts for one and llm/budget.ts for the other, and
  // do not join them without deciding out loud that they have merged.
  plan: text('plan').notNull().default('care'),
  /**
   * How build activity is presented across the product. `full` keeps a
   * concise technical summary on the surface; `simple` leads with the outcome
   * in ordinary language. The underlying run record is retained either way.
   */
  technicalDetail: text('technical_detail').notNull().default('simple'),
  /**
   * The tools this team already reaches for. This is onboarding context, not
   * a lock-in list: every agent remains available, while these choices are
   * placed first and their connection steps are made obvious.
   */
  preferredAgents: jsonb('preferred_agents').$type<string[]>(),
  agentPreferencesSetAt: timestamp('agent_preferences_set_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
