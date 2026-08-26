import { describe, expect, it } from 'vitest';
import { isSandboxCapacityError, sandboxNameFor, SANDBOX_AUTO_ARCHIVE_MINUTES } from '../../src/server/build/sandbox.js';

describe('sandbox capacity failures', () => {
  it('recognizes Daytona disk-limit failures without treating ordinary build errors as capacity', () => {
    expect(isSandboxCapacityError(new Error('Total disk limit exceeded. Maximum allowed: 30GiB. Consider archiving your unused Sandboxes to free up available storage.'))).toBe(true);
    expect(isSandboxCapacityError(new Error('tests failed'))).toBe(false);
  });
});

describe('sandbox dashboard names', () => {
  it('are readable, stable, DNS-safe, and org-scoped', () => {
    expect(sandboxNameFor('org_1', 'Loom App!')).toMatch(/^selvedge-loom-app-[0-9a-f]{6}$/);
    expect(sandboxNameFor('org_1', 'Loom App!')).toBe(sandboxNameFor('org_1', 'Loom App!'));
    expect(sandboxNameFor('org_1', 'loom')).not.toBe(sandboxNameFor('org_2', 'loom'));
  });
});

it('archives stopped sandboxes after one hour instead of deleting their files', () => {
  expect(SANDBOX_AUTO_ARCHIVE_MINUTES).toBe(60);
});
