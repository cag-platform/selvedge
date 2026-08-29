import type { MigrationOwnerTestFlow, MigrationPlan, MigrationPlanStep, MigrationProjectMap, MigrationVerification } from '../../shared/types/migration.js';

type Destinations = { repository?: string; hosting?: string; database?: string };

const externalKinds = new Set(['database', 'auth', 'storage', 'integration', 'secret']);

export function buildMigrationPlan(map: MigrationProjectMap, destinations: Destinations, now = new Date()): MigrationPlan {
  const observedExternal = map.items.filter((item) => item.status === 'found' && externalKinds.has(item.kind));
  const accessBlockers = observedExternal.map((item) => `Connect or provide development-safe access for ${item.label.toLowerCase()}.`);
  const destinationBlockers = [
    ...(!destinations.hosting ? ['Choose the target hosting account.'] : []),
    ...(!destinations.database && map.items.some((item) => item.kind === 'database' && item.status === 'found') ? ['Choose the target database.'] : []),
    ...accessBlockers,
    ['Independent verification must pass before shipping.'],
  ].flat();
  const steps: MigrationPlanStep[] = [
    { id: 'inspect', label: 'Inspect and map the project', state: 'complete', owner: 'migration_agent', detail: `${map.files_inspected} files inspected; ${map.stack.join(' + ') || 'application stack'} mapped.`, blockers: [] },
    { id: 'connect', label: 'Connect required services', state: accessBlockers.length ? 'blocked' : 'complete', owner: accessBlockers.length ? 'customer' : 'selvedge', detail: accessBlockers.length ? 'Selvedge found external services but will not guess or copy credentials.' : 'No external service access is currently blocking the safe copy.', blockers: accessBlockers },
    { id: 'workspace', label: 'Create an isolated workspace', state: 'ready', owner: 'selvedge', detail: 'Create a temporary development environment from the owner-controlled repository.', blockers: [] },
    { id: 'configure', label: 'Configure the development copy', state: accessBlockers.length ? 'blocked' : 'pending', owner: 'migration_agent', detail: 'Install dependencies and configure development-safe services without touching production.', blockers: accessBlockers },
    { id: 'preview', label: 'Open the live preview', state: 'pending', owner: 'migration_agent', detail: 'Start the application and expose it through Selvedge’s signed preview relay.', blockers: [] },
    { id: 'verify', label: 'Verify independently', state: 'pending', owner: 'verification_agent', detail: 'A different worker checks startup, visible behavior, screenshots, and migration evidence.', blockers: [] },
    { id: 'ship', label: 'Review and ship', state: destinationBlockers.length ? 'blocked' : 'approval_required', owner: 'customer', detail: 'Show the verified result and proposed production changes before any cutover.', blockers: destinationBlockers },
  ];
  const firstBlocked = steps.find((step) => step.state === 'blocked');
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    ready_to_start: Boolean(destinations.repository),
    steps,
    next_action: firstBlocked?.blockers[0] ?? 'Create the isolated workspace and begin the safe copy.',
  };
}

export function recordWorkspacePreparation(plan: MigrationPlan, result: { ok: true } | { ok: false; reason: string }, now = new Date()): MigrationPlan {
  const steps = plan.steps.map((step): MigrationPlanStep => {
    if (step.id !== 'workspace') return step;
    return result.ok
      ? { ...step, state: 'complete', detail: 'The isolated workspace is ready from the owner-controlled repository.', blockers: [] }
      : { ...step, state: 'blocked', detail: 'Selvedge could not prepare the isolated workspace yet.', blockers: [result.reason] };
  });
  const next = steps.find((step) => step.id === 'connect' && step.state === 'blocked')
    ?? steps.find((step) => step.state === 'blocked')
    ?? steps.find((step) => step.state === 'pending');
  return {
    ...plan,
    generated_at: now.toISOString(),
    steps,
    next_action: next?.blockers[0] ?? (result.ok ? 'Configure the development copy and start its preview.' : plan.next_action),
  };
}

export function recordPreviewPreparation(plan: MigrationPlan, result: { state: 'ready' | 'none' | 'error'; message: string | null }, now = new Date()): MigrationPlan {
  const steps = plan.steps.map((step): MigrationPlanStep => {
    if (step.id === 'configure' && result.state === 'ready') return { ...step, state: 'complete', detail: 'The development-safe copy is configured well enough to run.', blockers: [] };
    if (step.id !== 'preview') return step;
    if (result.state === 'ready') return { ...step, state: 'complete', detail: 'The app is running behind Selvedge’s signed preview relay.', blockers: [] };
    if (result.state === 'none') return { ...step, state: 'complete', detail: result.message ?? 'This project does not expose a browser preview.', blockers: [] };
    return { ...step, state: 'blocked', detail: 'The first automatic startup attempt needs configuration.', blockers: [result.message ?? 'The app did not start.'] };
  });
  const blocked = steps.find((step) => step.state === 'blocked');
  return {
    ...plan,
    generated_at: now.toISOString(),
    steps,
    next_action: blocked?.blockers[0] ?? (result.state === 'ready' ? 'Verify the running copy independently.' : 'Continue migration without a browser preview.'),
  };
}

export function rebuildMigrationPlan(map: MigrationProjectMap, destinations: Destinations, current: MigrationPlan, now = new Date()): MigrationPlan {
  const rebuilt = buildMigrationPlan(map, destinations, now);
  const keepProgress = new Set(['workspace', 'configure', 'preview', 'verify']);
  const merged = {
    ...rebuilt,
    steps: rebuilt.steps.map((step) => {
      const previous = current.steps.find((candidate) => candidate.id === step.id);
      return previous && keepProgress.has(step.id) && (previous.state === 'complete' || previous.state === 'blocked') ? previous : step;
    }),
  };
  return current.steps.find((step) => step.id === 'verify')?.state === 'complete'
    ? recordMigrationVerification(merged, { schema_version: 1, status: 'passed', verifier: 'selvedge-preview-verifier', independent_from_migration_agent: true, checks: [], screenshot_artifact_ids: [], screenshot_artifacts: [], console_errors: [], failed_requests: [], routes_checked: [], guided_journey: { status: 'passed', name: 'Legacy verified migration', steps: [] }, limitations: [], verified_at: now.toISOString() }, now)
    : merged;
}

export function recordMigrationVerification(plan: MigrationPlan, verification: MigrationVerification, now = new Date()): MigrationPlan {
  const steps = plan.steps.map((step): MigrationPlanStep => {
    if (step.id === 'verify') {
      if (verification.status === 'passed') return { ...step, state: 'complete', detail: 'An independent verifier opened and checked the running copy.', blockers: [] };
      return { ...step, state: 'blocked', detail: 'Independent verification did not pass.', blockers: verification.checks.filter((check) => check.status === 'failed').map((check) => check.detail).slice(0, 4).concat(verification.status === 'inconclusive' ? ['The verifier could not reach a conclusion.'] : []) };
    }
    if (step.id === 'ship') {
      const blockers = step.blockers.filter((blocker) => blocker !== 'Independent verification must pass before shipping.');
      if (verification.status !== 'passed') return { ...step, state: 'blocked', blockers: [...blockers, 'Independent verification must pass before shipping.'] };
      return { ...step, state: blockers.length ? 'blocked' : 'approval_required', blockers };
    }
    return step;
  });
  const blocked = steps.find((step) => step.state === 'blocked');
  return { ...plan, generated_at: now.toISOString(), steps, next_action: blocked?.blockers[0] ?? 'Review the verified copy and approve shipping when ready.' };
}

export function recordOwnerTestFlow(plan: MigrationPlan, flow: MigrationOwnerTestFlow, now = new Date()): MigrationPlan {
  const blocker = 'The owner-defined test flow must pass before shipping.';
  const steps = plan.steps.map((step): MigrationPlanStep => {
    if (step.id !== 'ship') return step;
    const blockers = step.blockers.filter((item) => item !== blocker);
    if (flow.status !== 'passed') blockers.push(blocker);
    return { ...step, state: blockers.length ? 'blocked' : 'approval_required', blockers };
  });
  const pendingApproval = flow.steps.find((step) => step.boundary === 'approval_required' && step.state === 'pending');
  return { ...plan, generated_at: now.toISOString(), steps, next_action: pendingApproval ? `Approve the “${pendingApproval.label}” test boundary before Selvedge runs it.` : 'Run the owner-defined test flow in the isolated preview.' };
}
