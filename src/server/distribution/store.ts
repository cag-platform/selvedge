import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { distributionHypotheses, distributionOpportunities, distributionPrograms, distributionSignals } from '../db/schema/index.js';
import { DEFAULT_SCORING_WEIGHTS, DISTRIBUTION_SCOPE, canTransitionOpportunity, overallScore, type OpportunityState, type ScoreComponents } from './domain.js';

export const SELVEDGE_PROGRAM_ID = 'distribution_program_selvedge';
const hypotheses = [
  ['H1', 'Context fragmentation', 'I use GPT, Claude, Codex, Cursor or other agents and none knows what I told the others.'],
  ['H2', 'Project amnesia', 'My AI does not remember why decisions were made earlier.'],
  ['H3', 'Maintenance fear', "I got the AI-built app working and now I'm afraid to change it."],
  ['H4', 'Agent coordination', 'I want to use whichever AI is best without manually coordinating all their context.'],
  ['H5', 'Ownership / understanding', 'AI built this software but I no longer fully understand what I own or why it works.'],
] as const;

export async function ensureSelvedgeDistributionProgram(db: Db) {
  await db.insert(distributionPrograms).values({
    id: SELVEDGE_PROGRAM_ID, orgId: DISTRIBUTION_SCOPE, name: 'Selvedge', objective: '50 activated Selvedge projects',
    primaryConversion: 'PROJECT_CONNECTED', secondaryConversion: 'SIGNUP', targetValue: 50,
    scoringWeights: DEFAULT_SCORING_WEIGHTS,
    autonomySettings: { find_opportunities: 'AUTO', score_opportunities: 'AUTO', draft_responses: 'AUTO', publish_responses: 'APPROVAL_REQUIRED', create_content: 'APPROVAL_REQUIRED', contact_prospects: 'OFF', paid_acquisition: 'OFF' },
    policy: { goal:'50 connected projects',primary_metric:'PROJECT_CONNECTED',target:50,deadline:null,budget_cents:0,allowed_channels:{reddit:true,twitter:true,hackernews:true},allowed_action_types:['REPLY'],autonomy:{find:'AUTO',score:'AUTO',draft:'AUTO',publish:'APPROVAL',content:'APPROVAL',outbound:'OFF',paid:'OFF'},daily_action_cap:10,per_platform_action_cap:5,minimum_opportunity_score:75,maximum_risk:40,hypothesis_allocation:{H1:2,H2:2,H3:2,H4:2,H5:1,EXPLORATION:1} },
  }).onConflictDoNothing();
  await db.insert(distributionHypotheses).values(hypotheses.map(([code, name, description]) => ({ id: `distribution_hypothesis_${code.toLowerCase()}`, orgId: DISTRIBUTION_SCOPE, programId: SELVEDGE_PROGRAM_ID, code, name, description }))).onConflictDoNothing();
  return distributionProgram(db);
}

export async function distributionProgram(db: Db) {
  const [program] = await db.select().from(distributionPrograms).where(and(eq(distributionPrograms.orgId, DISTRIBUTION_SCOPE), eq(distributionPrograms.id, SELVEDGE_PROGRAM_ID))).limit(1);
  if (!program) return null;
  const rows = await db.select().from(distributionHypotheses).where(and(eq(distributionHypotheses.orgId, DISTRIBUTION_SCOPE), eq(distributionHypotheses.programId, program.id)));
  return { ...program, hypotheses: rows.sort((a, b) => a.code.localeCompare(b.code)) };
}

export type SignalInput = typeof distributionSignals.$inferInsert;
export async function ingestSignal(db: Db, input: Omit<SignalInput, 'id' | 'orgId'>) {
  const [row] = await db.insert(distributionSignals).values({ ...input, id: ulid(), orgId: DISTRIBUTION_SCOPE }).onConflictDoNothing({ target: [distributionSignals.orgId, distributionSignals.dedupeKey] }).returning();
  if (row) return { signal: row, inserted: true };
  const [existing] = await db.select().from(distributionSignals).where(and(eq(distributionSignals.orgId, DISTRIBUTION_SCOPE), eq(distributionSignals.dedupeKey, input.dedupeKey))).limit(1);
  return { signal: existing!, inserted: false };
}

export async function createOpportunity(db: Db, input: { signalId?: string | null; hypothesisId?: string | null; opportunityType: string; audienceType: string; problemSummary: string; intentType: string; scores: ScoreComponents; reasoning: string; recommendedActionType: string }) {
  const [row] = await db.insert(distributionOpportunities).values({ id: ulid(), orgId: DISTRIBUTION_SCOPE, programId: SELVEDGE_PROGRAM_ID, signalId: input.signalId ?? null, hypothesisId: input.hypothesisId ?? null, opportunityType: input.opportunityType, audienceType: input.audienceType, problemSummary: input.problemSummary, intentType: input.intentType, fitScore: input.scores.fit, intentScore: input.scores.intent, freshnessScore: input.scores.freshness, audienceScore: input.scores.audience, engagementScore: input.scores.engagement, overallScore: overallScore(input.scores), reasoning: input.reasoning, recommendedActionType: input.recommendedActionType }).returning();
  return row!;
}

export async function transitionOpportunity(db: Db, id: string, to: OpportunityState) {
  const [current] = await db.select().from(distributionOpportunities).where(and(eq(distributionOpportunities.orgId, DISTRIBUTION_SCOPE), eq(distributionOpportunities.id, id))).limit(1);
  if (!current) throw new Error('opportunity not found');
  if (!canTransitionOpportunity(current.state as OpportunityState, to)) throw new Error(`invalid opportunity transition: ${current.state} -> ${to}`);
  const [updated] = await db.update(distributionOpportunities).set({ state: to, updatedAt: new Date() }).where(and(eq(distributionOpportunities.orgId, DISTRIBUTION_SCOPE), eq(distributionOpportunities.id, id))).returning();
  return updated!;
}
