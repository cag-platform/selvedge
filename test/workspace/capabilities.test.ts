import { describe, expect, it } from 'vitest';
import {
  InadequateWorkspaceRuntimeError,
  missingDevelopmentCapabilities,
  requireDevelopmentCapabilities,
} from '../../src/server/workspace/capabilities.js';
import type { WorkspaceCapabilities } from '../../src/server/workspace/types.js';

const complete: WorkspaceCapabilities = {
  longRunningProcesses: true,
  authenticatedPreview: true,
  browserAutomation: true,
  enforceableNetworkPolicy: true,
  commandScopedSecrets: true,
};

describe('Selvedge Development Workspace capability gate', () => {
  it('accepts a runtime that can run, show and independently inspect the candidate safely', () => {
    expect(missingDevelopmentCapabilities(complete)).toEqual([]);
    expect(() => requireDevelopmentCapabilities(complete)).not.toThrow();
  });

  it('rejects a code-only container with no safe preview, browser or network boundary', () => {
    const missing = missingDevelopmentCapabilities({
      ...complete,
      authenticatedPreview: false,
      browserAutomation: false,
      enforceableNetworkPolicy: false,
    });

    expect(missing).toEqual([
      'authenticatedPreview',
      'browserAutomation',
      'enforceableNetworkPolicy',
    ]);
    expect(() => requireDevelopmentCapabilities({ ...complete, browserAutomation: false })).toThrow(
      InadequateWorkspaceRuntimeError,
    );
  });
});
