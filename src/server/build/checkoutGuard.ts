import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns } from '../db/schema/index.js';
import { getBuild } from './store.js';
import type { BoundedChangePlan, CheckoutGuard, CheckoutGuardChoice, CheckoutResolution } from '../../shared/types/checkoutGuard.js';

const ACTIVE_FOR_MS = 45 * 60 * 1000;
const MAX_GOAL = 240;

function planFor(goal: string, expectedFiles: string[]): BoundedChangePlan {
  const cleanGoal = goal.trim().replace(/\s+/g, ' ').slice(0, MAX_GOAL);
  const files = [...new Set(expectedFiles.map((p) => p.trim()).filter(Boolean))].slice(0, 12);
  return {
    goal: cleanGoal,
    expected_area: files.length ? 'The named project files and their directly related tests.' : 'The smallest project area needed to complete this request.',
    expected_files: files,
    risk_boundary: 'No deployment, production-data change, broad refactor, dependency upgrade, or unrelated cleanup.',
    verification: ['Run the narrowest relevant automated checks.', 'Inspect the resulting diff and report evidence, including anything inconclusive.'],
    expected_duration_minutes: { minimum: 5, maximum: 20 },
    automatic_stop: {
      after_minutes: 20,
      conditions: ['The requested boundary must expand.', 'Verification exposes an unrelated failure.', 'The checkout state changes unexpectedly.', 'A production or irreversible action would be required.'],
    },
  };
}

function choices(state: CheckoutGuard['state'], sameThread: boolean): CheckoutGuardChoice[] {
  const available = (id: CheckoutResolution, label: string, effect: string, yes: boolean, unavailableReason: string | null = null): CheckoutGuardChoice => ({
    id, label, effect, available: yes, unavailable_reason: yes ? null : unavailableReason,
  });
  return [
    available('continue_existing', 'Continue this work', 'Use the current checkout and preserve its changes.', state === 'clean' || (state === 'attributable_existing_work' && sameThread), state === 'active_mutation' ? 'Another mutation is active.' : 'The existing changes are not attributable to this thread.'),
    available('review_existing', 'Review existing changes', 'Open the current work without starting a mutating turn.', state !== 'clean', state === 'clean' ? 'There are no existing changes to review.' : null),
    available('wait', 'Wait for current work', 'Leave the checkout untouched and try again after the active turn finishes.', state === 'active_mutation', state === 'active_mutation' ? null : 'No mutation is currently active.'),
    available('fresh_isolated', 'Use a fresh isolated checkout', 'Start from the repository branch without touching existing work.', false, 'This deployment currently has one persistent checkout per project and no isolated worktree support.'),
  ];
}

export async function inspectCheckout(
  db: Db,
  orgId: string,
  projectId: string,
  input: { threadId?: string | null; goal: string; expectedFiles?: string[] },
): Promise<CheckoutGuard> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ACTIVE_FOR_MS);
  const build = await getBuild(db, orgId, projectId);
  const [active, lastOwner] = await Promise.all([
    db.select({ id: agentRuns.id, threadId: agentRuns.threadId, agent: agentRuns.agent, startedAt: agentRuns.startedAt })
      .from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), eq(agentRuns.status, 'running'), gte(agentRuns.startedAt, cutoff))).orderBy(desc(agentRuns.startedAt)).limit(1).then((rows) => rows[0] ?? null),
    db.select({ changedPaths: agentRuns.changedPaths }).from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), eq(agentRuns.id, build?.dirtyRunId ?? ''))).limit(1).then((rows) => rows[0] ?? null),
  ]);

  let state: CheckoutGuard['state'] = 'clean';
  if (active) state = 'active_mutation';
  else if (build?.stagedChangesReady) state = build.dirtyRunId ? 'attributable_existing_work' : 'unattributed_dirty';
  const sameThread = Boolean(input.threadId && build?.dirtyThreadId === input.threadId);
  const safe = state === 'clean' || (state === 'attributable_existing_work' && sameThread);
  const changedPaths = Array.isArray(lastOwner?.changedPaths) ? lastOwner.changedPaths.filter((p): p is string => typeof p === 'string') : [];
  return {
    project_id: projectId,
    thread_id: input.threadId ?? null,
    state,
    safe_to_start: safe,
    inspected_at: now.toISOString(),
    ownership: active
      ? { run_id: active.id, thread_id: active.threadId, agent: active.agent, observed_at: active.startedAt?.toISOString() ?? now.toISOString() }
      : build?.dirtyRunId && build.dirtyObservedAt
        ? { run_id: build.dirtyRunId, thread_id: build.dirtyThreadId, agent: build.dirtyAgent, observed_at: build.dirtyObservedAt.toISOString() }
        : null,
    existing_work: build?.stagedChangesReady ? { changed_paths: changedPaths, observed_at: build.dirtyObservedAt?.toISOString() ?? null } : null,
    choices: choices(state, sameThread),
    fresh_isolated_checkout: { supported: false, reason: 'The current sandbox model keeps one persistent checkout per project; creating a second worktree is not yet supported.' },
    preview: { state: build?.previewUrl ? 'available' : 'not_started', url: build?.previewUrl ?? null, starts_or_wakes_on_open: true },
    plan: planFor(input.goal, input.expectedFiles ?? []),
  };
}

export function canResolveCheckout(guard: CheckoutGuard, resolution: unknown): boolean {
  if (guard.safe_to_start) return true;
  return guard.choices.some((choice) => choice.id === resolution && choice.available && choice.id === 'continue_existing');
}
