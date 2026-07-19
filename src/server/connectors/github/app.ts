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
  return { appId, privateKey: privateKey.replace(/\\n/g, '\n') };
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
