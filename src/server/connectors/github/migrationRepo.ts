import { createAppAuth } from '@octokit/auth-app';
import type { Db } from '../../db/client.js';
import type { AppFile } from '../../import/replitApp.js';
import { loadGithubAppConfig } from './app.js';
import { listInstallations } from './health.js';
import { GithubError } from './newRepo.js';
import { pushFilesToRepoWithToken, type PushResult } from './pushFiles.js';

const API = 'https://api.github.com';

export type ProvisionedMigrationRepo = {
  fullName: string;
  pushed: PushResult;
};

export type MigrationRepoDeps = {
  installations?: typeof listInstallations;
  mint?: (installationId: string) => Promise<string>;
  request?: typeof fetch;
  push?: typeof pushFilesToRepoWithToken;
};

function githubMessage(status: number, message?: string): GithubError {
  if (status === 401) return new GithubError('GitHub refused the installation credential. Reconnect the Selvedge GitHub App and try again.');
  if (status === 403) return new GithubError('The Selvedge GitHub App needs Administration (write) and Contents (write) permission to create the private repo and import its files. Update the installation and try again.');
  if (status === 422) return new GithubError(`GitHub could not create that repository${message ? `: ${message}` : ''}`, /already exists/i.test(message ?? ''));
  return new GithubError(`GitHub responded ${status}${message ? `: ${message}` : ''}`);
}

async function mintInstallationToken(installationId: string): Promise<string> {
  const config = loadGithubAppConfig();
  const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  const result = await auth({ type: 'installation', installationId });
  return result.token;
}

/**
 * Create and fill a migration repository with the customer's GitHub App
 * installation. The same short-lived credential performs both acts, so repo
 * creation and code access cannot drift between two identities.
 *
 * GitHub only permits installation tokens to create organization repositories;
 * personal-account arrivals use the separate one-time OAuth setup flow.
 */
export async function provisionMigrationRepo(
  db: Db,
  orgId: string,
  name: string,
  description: string,
  files: AppFile[],
  deps: MigrationRepoDeps = {},
): Promise<ProvisionedMigrationRepo> {
  const installations = await (deps.installations ?? listInstallations)(db, orgId);
  const installation = installations[0];
  if (!installation) {
    throw new GithubError('Connect the Selvedge GitHub App before importing. It creates the private repository in your account and receives only the permissions you approve.');
  }
  const owner = installation.meta?.trim();
  if (!owner || owner === 'unknown') {
    throw new GithubError('The GitHub connection is missing its destination account. Reconnect the Selvedge GitHub App and try again.');
  }

  let token: string;
  try {
    token = await (deps.mint ?? mintInstallationToken)(installation.sourceAccountId);
  } catch {
    throw new GithubError('GitHub would not issue a short-lived installation credential. Reconnect the Selvedge GitHub App and try again.');
  }

  const request = deps.request ?? fetch;
  let response: Response;
  try {
    response = await request(`${API}/orgs/${encodeURIComponent(owner)}/repos`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, description, private: true, auto_init: true }),
    });
  } catch (error) {
    throw new GithubError(`could not reach GitHub (${error instanceof Error ? error.message : String(error)})`);
  }
  const body = await response.json().catch(() => null) as { full_name?: string; message?: string } | null;
  if (!response.ok || !body?.full_name) throw githubMessage(response.status, body?.message);

  try {
    const pushed = await (deps.push ?? pushFilesToRepoWithToken)(token, body.full_name, files, 'Imported from Replit');
    return { fullName: body.full_name, pushed };
  } catch (error) {
    if (error instanceof GithubError && /404|not found/i.test(error.message)) {
      throw new GithubError(`GitHub created ${body.full_name}, but this installation is limited to selected repositories. Add the new repository to the Selvedge GitHub App, then import into that existing project.`);
    }
    throw error;
  }
}
