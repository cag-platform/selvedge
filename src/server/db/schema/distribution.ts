import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const distributionPrograms = pgTable('distribution_programs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id'),
  name: text('name').notNull(),
  objective: text('objective').notNull(),
  primaryConversion: text('primary_conversion').notNull(),
  secondaryConversion: text('secondary_conversion'),
  targetValue: integer('target_value').notNull(),
  targetDate: timestamp('target_date', { withTimezone: true }),
  budgetCents: integer('budget_cents'),
  status: text('status').notNull().default('ACTIVE'),
  scoringWeights: jsonb('scoring_weights').notNull(),
  autonomySettings: jsonb('autonomy_settings').notNull(),
  policy: jsonb('policy').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('distribution_programs_org_name_idx').on(t.orgId, t.name)]);

export const distributionHypotheses = pgTable('distribution_hypotheses', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  programId: text('program_id').notNull().references(() => distributionPrograms.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('distribution_hypotheses_program_code_idx').on(t.programId, t.code), index('distribution_hypotheses_org_idx').on(t.orgId)]);

export const distributionSignals = pgTable('distribution_signals', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  provider: text('provider').notNull(),
  providerExternalId: text('provider_external_id'),
  platform: text('platform').notNull(),
  url: text('url'),
  authorHandle: text('author_handle'),
  authorName: text('author_name'),
  content: text('content').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  rawPayload: jsonb('raw_payload').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  processingStatus: text('processing_status').notNull().default('NEW'),
  classification: jsonb('classification'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [uniqueIndex('distribution_signals_org_dedupe_idx').on(t.orgId, t.dedupeKey), index('distribution_signals_processing_idx').on(t.orgId, t.processingStatus)]);

export const distributionOpportunities = pgTable('distribution_opportunities', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  signalId: text('signal_id').references(() => distributionSignals.id),
  programId: text('program_id').notNull().references(() => distributionPrograms.id),
  opportunityType: text('opportunity_type').notNull(),
  hypothesisId: text('hypothesis_id').references(() => distributionHypotheses.id),
  audienceType: text('audience_type').notNull(),
  problemSummary: text('problem_summary').notNull(),
  intentType: text('intent_type').notNull(),
  fitScore: integer('fit_score').notNull(),
  intentScore: integer('intent_score').notNull(),
  freshnessScore: integer('freshness_score').notNull(),
  audienceScore: integer('audience_score').notNull(),
  engagementScore: integer('engagement_score').notNull(),
  actionabilityScore: integer('actionability_score').notNull().default(0),
  riskScore: integer('risk_score').notNull().default(0),
  canHelpWithoutPitching: boolean('can_help_without_pitching').notNull().default(false),
  productMentionAppropriate: boolean('product_mention_appropriate').notNull().default(false),
  scoringVersion: text('scoring_version').notNull().default('v1'),
  discoverySource: text('discovery_source').notNull().default('MACHINE_FOUND'),
  overallScore: integer('overall_score').notNull(),
  reasoning: text('reasoning').notNull(),
  recommendedActionType: text('recommended_action_type').notNull(),
  state: text('state').notNull().default('NEW'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('distribution_opportunities_signal_program_idx').on(t.signalId, t.programId), index('distribution_opportunities_queue_idx').on(t.orgId, t.programId, t.state)]);

export const distributionDrafts = pgTable('distribution_drafts', {
  id: text('id').primaryKey(), orgId: text('org_id').notNull(),
  opportunityId: text('opportunity_id').notNull().references(() => distributionOpportunities.id),
  body: text('body').notNull(), initialBody: text('initial_body').notNull().default(''), finalBody: text('final_body'), responseMode: text('response_mode').notNull().default('HELP_ONLY'), promptVersion: text('prompt_version').notNull().default('v1'), modelMetadata: jsonb('model_metadata'), version: integer('version').notNull(),
  status: text('status').notNull(), editedByHuman: boolean('edited_by_human').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('distribution_drafts_opportunity_version_idx').on(t.opportunityId, t.version), index('distribution_drafts_org_idx').on(t.orgId)]);

export const distributionActions = pgTable('distribution_actions', {
  id: text('id').primaryKey(), orgId: text('org_id').notNull(), opportunityId: text('opportunity_id').notNull().references(() => distributionOpportunities.id),
  actionType: text('action_type').notNull(), finalContent: text('final_content'), externalUrl: text('external_url'),
  actedAt: timestamp('acted_at', { withTimezone: true }), actor: text('actor').notNull(), status: text('status').notNull(), metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('distribution_actions_opportunity_idx').on(t.orgId, t.opportunityId)]);

export const distributionOutcomes = pgTable('distribution_outcomes', {
  id: text('id').primaryKey(), orgId: text('org_id').notNull(), opportunityId: text('opportunity_id').references(() => distributionOpportunities.id),
  actionId: text('action_id').references(() => distributionActions.id), outcomeType: text('outcome_type').notNull(), value: numeric('value'),
  source: text('source').notNull(), confidence: integer('confidence'), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(), metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('distribution_outcomes_opportunity_idx').on(t.orgId, t.opportunityId)]);

export const distributionIngestionRuns = pgTable('distribution_ingestion_runs', {
  id: text('id').primaryKey(), orgId: text('org_id').notNull(), provider: text('provider').notNull(), status: text('status').notNull().default('RUNNING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true }),
  searches: jsonb('searches').notNull(), recordsFound: integer('records_found').notNull().default(0), recordsInserted: integer('records_inserted').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0), failures: integer('failures').notNull().default(0), lastError: text('last_error'),
}, (t) => [index('distribution_ingestion_runs_provider_started_idx').on(t.orgId, t.provider, t.startedAt)]);

export const distributionExperiments = pgTable('distribution_experiments', {
  id:text('id').primaryKey(), orgId:text('org_id').notNull(), programId:text('program_id').notNull().references(()=>distributionPrograms.id), name:text('name').notNull(), hypothesis:text('hypothesis').notNull(),
  startsAt:timestamp('starts_at',{withTimezone:true}), endsAt:timestamp('ends_at',{withTimezone:true}), status:text('status').notNull().default('PLANNED'), comparisonDimensions:jsonb('comparison_dimensions').notNull(), successMetric:text('success_metric').notNull(), notes:text('notes'), results:text('results'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('distribution_experiments_program_name_idx').on(t.programId,t.name),index('distribution_experiments_org_idx').on(t.orgId)]);

export const distributionReferralSources = pgTable('distribution_referral_sources', {
  id:text('id').primaryKey(), orgId:text('org_id').notNull(), userId:text('user_id'), rawAnswer:text('raw_answer').notNull(), createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[index('distribution_referral_sources_org_idx').on(t.orgId,t.createdAt)]);
