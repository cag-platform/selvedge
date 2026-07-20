import { createPrivateKey } from 'node:crypto';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';

export type GithubAppConfig = {
  appId: string;
  privateKey: string;
};

export function loadGithubAppConfig(): GithubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set');
  }
  // Railway (and most env-var UIs) can't hold real newlines; allow \n escapes.
  const pem = privateKey.replace(/\\n/g, '\n');
  // GitHub downloads keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but octokit's
  // WebCrypto path only imports PKCS#8 — normalize through node:crypto, which
  // reads both. Throws early (without echoing the key) if the PEM is mangled.
  let normalized: string;
  try {
    normalized = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a readable PEM private key (value withheld from logs)');
  }
  return { appId, privateKey: normalized };
}

/** An Octokit client authenticated as a specific installation — used for backfill. */
export function getInstallationOctokit(config: GithubAppConfig, installationId: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
    },
  });
}
