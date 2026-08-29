import type { MigrationPlan, MigrationPlanStep, MigrationProjectMap } from '../../shared/types/migration.js';

type Destinations = { repository?: string; hosting?: string; database?: string };

const externalKinds = new Set(['database', 'auth', 'storage', 'integration', 'secret']);

export function buildMigrationPlan(map: MigrationProjectMap, destinations: Destinations, now = new Date()): MigrationPlan {
  const observedExternal = map.items.filter((item) => item.status === 'found' && externalKinds.has(item.kind));
  const accessBlockers = observedExternal.map((item) => `Connect or provide development-safe access for ${item.label.toLowerCase()}.`);
  const destinationBlockers = [
    ...(!destinations.hosting ? ['Choose the target hosting account.'] : []),
    ...(!destinations.database && map.items.some((item) => item.kind === 'database' && item.status === 'found') ? ['Choose the target database.'] : []),
  ];
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
