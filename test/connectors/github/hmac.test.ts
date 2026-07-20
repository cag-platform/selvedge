import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithubSignature } from '../../../src/server/connectors/github/hmac.js';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('connectors/github/hmac', () => {
  it('accepts a correctly signed payload', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = sign(body.toString(), 'shh');
    expect(verifyGithubSignature(body, sig, 'shh')).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = sign(body.toString(), 'wrong-secret');
    expect(verifyGithubSignature(body, sig, 'shh')).toBe(false);
  });

  it('rejects a tampered body', () => {
    const original = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = sign(original.toString(), 'shh');
    const tampered = Buffer.from(JSON.stringify({ hello: 'mallory' }));
    expect(verifyGithubSignature(tampered, sig, 'shh')).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{}');
    expect(verifyGithubSignature(body, undefined, 'shh')).toBe(false);
  });

  it('rejects a signature of a different length without throwing', () => {
    const body = Buffer.from('{}');
    expect(verifyGithubSignature(body, 'sha256=short', 'shh')).toBe(false);
  });
});
