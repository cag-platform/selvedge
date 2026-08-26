import { describe, expect, it } from 'vitest';
import { isSandboxCapacityError } from '../../src/server/build/sandbox.js';

describe('sandbox capacity failures', () => {
  it('recognizes Daytona disk-limit failures without treating ordinary build errors as capacity', () => {
    expect(isSandboxCapacityError(new Error('Total disk limit exceeded. Maximum allowed: 30GiB. Consider archiving your unused Sandboxes to free up available storage.'))).toBe(true);
    expect(isSandboxCapacityError(new Error('tests failed'))).toBe(false);
  });
});
