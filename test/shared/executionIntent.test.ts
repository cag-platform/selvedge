import { describe, expect, it } from 'vitest';
import { executionModeFor } from '../../src/shared/executionIntent.js';

describe('execution intent', () => {
  it('routes inspection and planning read-only while preserving explicit implementation', () => {
    expect(executionModeFor('Look at the code and plan the migration. Walk me through it.')).toBe('plan');
    expect(executionModeFor('Implement the migration now.')).toBe('build');
    expect(executionModeFor('Plan it', 'build')).toBe('build');
  });
});
