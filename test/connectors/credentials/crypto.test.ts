import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptCredential, decryptCredential } from '../../../src/server/connectors/credentials/crypto.js';

/**
 * These tests assert the three security properties the module documents. Two
 * of them (cross-org and cross-provider isolation) are enforced by
 * cryptography, so a regression here is a silent tenancy or scoping leak that
 * no WHERE-clause test would catch — exactly the class of defect this whole
 * codebase has shipped before.
 */
describe('credentials/crypto', () => {
  const KEY = 'x'.repeat(48); // >= 32 chars

  beforeEach(() => {
    process.env.CREDENTIALS_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.CREDENTIALS_KEY;
  });

  it('round-trips a value for the same org and provider', () => {
    const secret = 'sk-ant-api03-super-secret-token';
    const enc = encryptCredential('org_a', 'anthropic', secret);
    expect(enc).not.toContain(secret); // never stored in the clear
    expect(decryptCredential('org_a', 'anthropic', enc)).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const a = encryptCredential('org_a', 'anthropic', 'same-value');
    const b = encryptCredential('org_a', 'anthropic', 'same-value');
    expect(a).not.toBe(b);
    expect(decryptCredential('org_a', 'anthropic', a)).toBe('same-value');
    expect(decryptCredential('org_a', 'anthropic', b)).toBe('same-value');
  });

  it("another org cannot decrypt this org's credential (per-org keys)", () => {
    const enc = encryptCredential('org_a', 'anthropic', 'org-a-token');
    // A bug that serves org_b the row belonging to org_a gets ciphertext it
    // cannot read, rather than the plaintext token.
    expect(() => decryptCredential('org_b', 'anthropic', enc)).toThrow();
  });

  it('a credential relabelled to another provider fails to decrypt (AAD binding)', () => {
    const enc = encryptCredential('org_a', 'anthropic', 'org-a-token');
    // Copying the row's value into a different provider slot fails outright —
    // moving a credential must be a deliberate decrypt-and-re-encrypt.
    expect(() => decryptCredential('org_a', 'openai', enc)).toThrow();
  });

  it('a tampered ciphertext fails the auth tag rather than returning garbage', () => {
    const enc = encryptCredential('org_a', 'anthropic', 'org-a-token');
    const parts = enc.split(':');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3] as string, 'base64');
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptCredential('org_a', 'anthropic', parts.join(':'))).toThrow();
  });

  it('rejects a malformed or unversioned ciphertext', () => {
    expect(() => decryptCredential('org_a', 'anthropic', 'not-a-real-ciphertext')).toThrow();
    expect(() => decryptCredential('org_a', 'anthropic', 'v99:a:b:c')).toThrow(/unsupported version/);
  });

  it('fails closed when the key is missing or too short — never falls back', () => {
    delete process.env.CREDENTIALS_KEY;
    expect(() => encryptCredential('org_a', 'anthropic', 'x')).toThrow(/CREDENTIALS_KEY/);
    process.env.CREDENTIALS_KEY = 'too-short';
    expect(() => encryptCredential('org_a', 'anthropic', 'x')).toThrow(/>=32/);
  });
});
