import type { Db } from '../db/client.js';
import type { LlmClient } from '../llm/types.js';
import { buildGraderClient } from '../llm/factory.js';
import { evalModel } from '../llm/config.js';
import { checkGradeBudget } from '../llm/budget.js';
import { recordUsage } from '../llm/metering.js';

export type GuidedCandidate = { id: string; label: string; kind: 'button' | 'summary' | 'tab' };
export type GuidedPlan = { name: string; steps: Array<{ candidateId: string; intent: string }> };

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    steps: { type: 'array', maxItems: 3, items: { type: 'object', properties: { candidate_id: { type: 'string' }, intent: { type: 'string' } }, required: ['candidate_id', 'intent'], additionalProperties: false } },
  },
  required: ['name', 'steps'],
  additionalProperties: false,
} as const;

export async function planMigrationGuidedJourney(db: Db, orgId: string, candidates: GuidedCandidate[], llm: LlmClient | undefined = buildGraderClient()): Promise<GuidedPlan | null> {
  if (!candidates.length) return { name: 'No safe interaction needed', steps: [] };
  if (!llm) return null;
  const budget = await checkGradeBudget(db, orgId);
  if (budget.over) return null;
  const result = await llm.complete({
    model: evalModel(),
    system: 'You plan a tiny read-only UI smoke journey. Select only controls from the supplied allowlist. Prefer navigation menus, tabs, accordions, view switches, and informational dialogs that reveal whether the app works. Never infer or request form submission, account changes, external communication, purchases, uploads, authentication, or destructive actions. Return zero steps when none adds useful evidence.',
    userContent: `Allowed controls:\n${candidates.map((candidate) => `${candidate.id} | ${candidate.kind} | ${candidate.label}`).join('\n')}`,
    maxTokens: 500,
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(db, orgId, 'grade', result);
  if (!result.ok) return null;
  const json = result.json as { name?: unknown; steps?: Array<{ candidate_id?: unknown; intent?: unknown }> };
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  if (typeof json.name !== 'string' || !Array.isArray(json.steps)) return null;
  const seen = new Set<string>();
  const steps = json.steps.flatMap((step) => {
    if (typeof step?.candidate_id !== 'string' || !allowed.has(step.candidate_id) || seen.has(step.candidate_id) || typeof step.intent !== 'string' || !step.intent.trim()) return [];
    seen.add(step.candidate_id);
    return [{ candidateId: step.candidate_id, intent: step.intent.trim().slice(0, 200) }];
  }).slice(0, 3);
  return { name: json.name.trim().slice(0, 120) || 'Guided smoke journey', steps };
}
