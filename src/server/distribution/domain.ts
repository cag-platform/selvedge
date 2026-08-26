export const DISTRIBUTION_SCOPE = 'internal:selvedge-distribution';
export const OPPORTUNITY_TYPES = ['CONVERSATION', 'SEARCH', 'CONTENT', 'COMPETITOR', 'COMMUNITY', 'PARTNERSHIP', 'PROSPECT', 'CREATOR', 'LAUNCH', 'SEO'] as const;
export const OPPORTUNITY_STATES = ['NEW', 'READY', 'DRAFTED', 'APPROVED', 'SKIPPED', 'ACTED', 'ARCHIVED'] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const DEFAULT_SCORING_WEIGHTS = { fit: 30, intent: 25, freshness: 15, audience: 15, engagement: 15 } as const;
export type ScoreComponents = { fit: number; intent: number; freshness: number; audience: number; engagement: number };
export type ScoreWeights = Record<keyof ScoreComponents, number>;

export function overallScore(components: ScoreComponents, weights: ScoreWeights = DEFAULT_SCORING_WEIGHTS): number {
  const keys = Object.keys(components) as Array<keyof ScoreComponents>;
  const bounded = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const totalWeight = keys.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  if (totalWeight === 0) return 0;
  return Math.round(keys.reduce((sum, key) => sum + bounded(components[key]) * Math.max(0, weights[key]), 0) / totalWeight);
}

const TRANSITIONS: Record<OpportunityState, readonly OpportunityState[]> = {
  NEW: ['READY', 'SKIPPED', 'ARCHIVED'], READY: ['DRAFTED','APPROVED', 'SKIPPED', 'ARCHIVED'], DRAFTED:['APPROVED','SKIPPED','ARCHIVED'],
  APPROVED: ['ACTED', 'SKIPPED', 'ARCHIVED'], SKIPPED: ['READY', 'ARCHIVED'], ACTED: ['ARCHIVED'], ARCHIVED: [],
};
export function canTransitionOpportunity(from: OpportunityState, to: OpportunityState): boolean { return TRANSITIONS[from].includes(to); }
