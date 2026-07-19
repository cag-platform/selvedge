import { describe, it, expect } from 'vitest';
import { validatePack, assertValidPack, PackValidationError } from '../../src/server/packs/validate.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('packs/validate', () => {
  it('accepts a well-formed pack', () => {
    const result = validatePack(makeTestPack());
    expect(result.valid).toBe(true);
  });

  it('rejects a pack missing a required field', () => {
    const pack: any = makeTestPack();
    delete pack.stakes.tier;
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/tier/);
    }
  });

  it('rejects an invalid enum value', () => {
    const pack: any = makeTestPack();
    pack.stakes.tier = 'extremely_critical';
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
  });

  it('assertValidPack throws PackValidationError with details on invalid input', () => {
    const pack: any = makeTestPack();
    pack.voice.detail_level = 'nonsense';
    expect(() => assertValidPack(pack)).toThrow(PackValidationError);
  });
});
