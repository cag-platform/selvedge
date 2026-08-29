import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import type { LlmClient } from '../llm/types.js';
import { buildGraderClient } from '../llm/factory.js';
import { evalModel } from '../llm/config.js';
import { checkGradeBudget } from '../llm/budget.js';
import { recordUsage } from '../llm/metering.js';
import type { MigrationOwnerTestFlow } from '../../shared/types/migration.js';

const FLOW_SCHEMA = {
  type: 'object',
  properties: {
    steps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' }, boundary: { type: 'string', enum: ['automatic', 'approval_required'] } }, required: ['label', 'detail', 'boundary'], additionalProperties: false } },
  },
  required: ['steps'],
  additionalProperties: false,
} as const;

const CONSEQUENTIAL = /\b(sign\s*in|log\s*in|password|credential|secret|token|submit|save|send|publish|post|create|update|edit|delete|remove|upload|download|invite|share|connect|authorize|purchase|checkout|buy|pay|refund|cancel|production|customer|email|message)\b/i;

export async function createOwnerTestFlow(db: Db, orgId: string, goal: string, now = new Date(), llm: LlmClient | undefined = buildGraderClient()): Promise<MigrationOwnerTestFlow | null> {
  if (!llm) return null;
  const budget = await checkGradeBudget(db, orgId);
  if (budget.over) return null;
  const result = await llm.complete({
    model: evalModel(),
    system: 'Turn the owner’s requested app journey into a short observable verification plan. Each step must say what Selvedge will check. Mark passive navigation, viewing, tabs, menus, filters, and non-mutating inspection automatic. Mark credentials, form submission, writes, account or production changes, uploads, external communication, purchases, and any ambiguous consequential action approval_required. Do not request actual secret values and do not claim the steps have run.',
    userContent: `Owner-defined journey:\n${goal}`,
    maxTokens: 900,
    schema: FLOW_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(db, orgId, 'grade', result);
  if (!result.ok) return null;
  const json = result.json as { steps?: Array<{ label?: unknown; detail?: unknown; boundary?: unknown }> };
  if (!Array.isArray(json.steps) || !json.steps.length) return null;
  const steps = json.steps.slice(0, 8).flatMap((step) => {
    if (typeof step.label !== 'string' || !step.label.trim() || typeof step.detail !== 'string' || !step.detail.trim()) return [];
    const modelBoundary = step.boundary === 'automatic' ? 'automatic' : 'approval_required';
    const boundary = CONSEQUENTIAL.test(`${step.label} ${step.detail}`) ? 'approval_required' : modelBoundary;
    return [{ id: ulid(), label: step.label.trim().slice(0, 120), detail: step.detail.trim().slice(0, 500), boundary, state: boundary === 'automatic' ? 'ready' : 'pending' } satisfies MigrationOwnerTestFlow['steps'][number]];
  });
  if (!steps.length) return null;
  const timestamp = now.toISOString();
  return { schema_version: 1, goal, status: steps.some((step) => step.boundary === 'approval_required') ? 'approval_required' : 'ready', steps, created_at: timestamp, updated_at: timestamp };
}

export function approveOwnerTestFlowStep(flow: MigrationOwnerTestFlow, stepId: string, now = new Date()): MigrationOwnerTestFlow | null {
  const target = flow.steps.find((step) => step.id === stepId);
  if (!target || target.boundary !== 'approval_required' || target.state !== 'pending') return null;
  const steps = flow.steps.map((step) => step.id === stepId ? { ...step, state: 'approved' as const } : step);
  return { ...flow, steps, status: steps.some((step) => step.boundary === 'approval_required' && step.state === 'pending') ? 'approval_required' : 'ready', updated_at: now.toISOString() };
}
