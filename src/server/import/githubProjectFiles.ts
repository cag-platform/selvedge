import type { Db } from '../db/client.js';
import { getInstallationOctokit, loadGithubAppConfig } from '../connectors/github/app.js';
import { listInstallations } from '../connectors/github/health.js';
import type { AppFile } from './replitApp.js';

export type GithubProjectFiles = { files: AppFile[]; truncated: boolean; defaultBranch: string };

const CONTENT_FILE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|Pipfile|Dockerfile|vercel\.json|netlify\.toml|railway\.json|fly\.toml|\.env\.example|schema\.prisma)$|\.(?:js|jsx|ts|tsx|py|toml|ya?ml|sql)$/i;
const PRIORITY_FILE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|Pipfile|Dockerfile|vercel\.json|netlify\.toml|railway\.json|fly\.toml|\.env\.example|schema\.prisma)$/i;

/** Read enough of an installed repository to map it without cloning or executing it. */
export async function readGithubProjectFiles(db: Db, orgId: string, fullName: string): Promise<GithubProjectFiles> {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error('Choose a GitHub repository like owner/repo.');
  const [installation] = await listInstallations(db, orgId);
  if (!installation) throw new Error('Install the Selvedge GitHub App before choosing a repository.');
  const octokit = getInstallationOctokit(loadGithubAppConfig(), installation.sourceAccountId);
  const { data: repository } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repository.default_branch;
  const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: defaultBranch, recursive: 'true' });
  const blobs = tree.tree.filter((item): item is typeof item & { path: string; sha: string; size?: number } => item.type === 'blob' && typeof item.path === 'string' && typeof item.sha === 'string').slice(0, 2_000);
  const files = new Map<string, AppFile>(blobs.map((item) => [item.path, { path: item.path, bytes: new Uint8Array() }]));
  const readable = blobs.filter((item) => (item.size ?? 0) <= 300_000 && CONTENT_FILE.test(item.path)).sort((a, b) => Number(PRIORITY_FILE.test(b.path)) - Number(PRIORITY_FILE.test(a.path))).slice(0, 40);
  await Promise.all(readable.map(async (item) => {
    const { data: blob } = await octokit.rest.git.getBlob({ owner, repo, file_sha: item.sha });
    if (blob.encoding !== 'base64') return;
    files.set(item.path, { path: item.path, bytes: new Uint8Array(Buffer.from(blob.content.replace(/\n/g, ''), 'base64')) });
  }));
  return { files: [...files.values()], truncated: Boolean(tree.truncated || tree.tree.length > 2_000), defaultBranch };
}
