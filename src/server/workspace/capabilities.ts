import type { WorkspaceCapabilities } from './types.js';

/**
 * Selvedge promises a running, inspectable candidate rather than a blind code
 * edit. A runtime missing any capability below cannot power a Development
 * Workspace and must be rejected before customer code or secrets reach it.
 */
export const DEVELOPMENT_WORKSPACE_REQUIREMENTS: WorkspaceCapabilities = {
  longRunningProcesses: true,
  authenticatedPreview: true,
  browserAutomation: true,
  enforceableNetworkPolicy: true,
  commandScopedSecrets: true,
};

export type WorkspaceCapability = keyof WorkspaceCapabilities;

export function missingDevelopmentCapabilities(
  actual: WorkspaceCapabilities,
): WorkspaceCapability[] {
  return (Object.keys(DEVELOPMENT_WORKSPACE_REQUIREMENTS) as WorkspaceCapability[]).filter(
    (capability) => DEVELOPMENT_WORKSPACE_REQUIREMENTS[capability] && !actual[capability],
  );
}
export class InadequateWorkspaceRuntimeError extends Error {
  constructor(readonly missing: WorkspaceCapability[]) {
    super(`workspace runtime is missing required capabilities: ${missing.join(', ')}`);
    this.name = 'InadequateWorkspaceRuntimeError';
  }
}

export function requireDevelopmentCapabilities(actual: WorkspaceCapabilities): void {
  const missing = missingDevelopmentCapabilities(actual);
  if (missing.length) throw new InadequateWorkspaceRuntimeError(missing);
}
