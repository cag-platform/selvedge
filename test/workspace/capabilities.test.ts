import { describe, expect, it } from 'vitest';
import {
  InadequateWorkspaceRuntimeError,
  missingDevelopmentCapabilities,
  requireDevelopmentCapabilities,
  supportsWorkspaceRequirements,
} from '../../src/server/workspace/capabilities.js';
import { APPLE_WORKSPACE_REQUIREMENTS, WEB_WORKSPACE_REQUIREMENTS } from '../../src/server/workspace/requirements.js';
import type { WorkspaceCapabilities } from '../../src/server/workspace/types.js';

const complete: WorkspaceCapabilities = {
  longRunningProcesses: true,
  authenticatedPreview: true,
  browserAutomation: true,
  enforceableNetworkPolicy: true,
  commandScopedSecrets: true,
  platforms: ['linux'],
  nativeTools: [],
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

  it('distinguishes a browser workspace from an Apple/Xcode workspace', () => {
    expect(supportsWorkspaceRequirements(complete, WEB_WORKSPACE_REQUIREMENTS)).toBe(true);
    expect(supportsWorkspaceRequirements(complete, APPLE_WORKSPACE_REQUIREMENTS)).toBe(false);
    expect(supportsWorkspaceRequirements({ ...complete, platforms: ['linux', 'apple'], nativeTools: ['xcode', 'ios-simulator'] }, APPLE_WORKSPACE_REQUIREMENTS)).toBe(true);
  });
});
