import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGithubAppConfig } from '../../../src/server/connectors/github/app.js';

/**
 * GitHub downloads App private keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"),
 * but octokit's WebCrypto JWT path only imports PKCS#8 — feeding it the
 * raw download crashes with "Invalid keyData" at the first authenticated
 * call (the install callback, in production). loadGithubAppConfig must
 * normalize both formats and reject garbage without echoing it.
 */
describe('loadGithubAppConfig', () => {
  const savedAppId = process.env.GITHUB_APP_ID;
  const savedKey = process.env.GITHUB_APP_PRIVATE_KEY;

  afterEach(() => {
    process.env.GITHUB_APP_ID = savedAppId;
    process.env.GITHUB_APP_PRIVATE_KEY = savedKey;
  });

  function generate(type: 'pkcs1' | 'pkcs8'): string {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: type === 'pkcs1' ? 'pkcs1' : 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return privateKey;
  }

  it("normalizes GitHub's PKCS#1 download to PKCS#8", () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = generate('pkcs1');
    const config = loadGithubAppConfig();
    expect(config.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(config.privateKey).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('passes an already-PKCS#8 key through intact', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = generate('pkcs8');
    expect(loadGithubAppConfig().privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('accepts \\n-escaped single-line keys (env-var UIs)', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = generate('pkcs1').replace(/\n/g, '\\n');
    expect(loadGithubAppConfig().privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('rejects a mangled key without echoing its contents', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'sk-ant-oops-wrong-paste';
    expect(() => loadGithubAppConfig()).toThrow(/not a readable PEM/);
    expect(() => loadGithubAppConfig()).toThrow(/withheld from logs/);
  });
});
