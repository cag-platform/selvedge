import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { getBuild, setBuild, clearSandbox } from './store.js';
import type { CreateWorkspaceInput, Workspace, WorkspaceExecResult } from '../workspace/types.js';
import { OpenAiWorkspaceApiError, OpenAiWorkspaceClient } from '../workspace/openai/client.js';
import { OpenAiWorkspaceRuntime } from '../workspace/openai/runtime.js';
import { getPreviewRelay } from '../workspace/relay/factory.js';
import { closeSandboxRun, openSandboxRun } from './metering.js';

export const WORKDIR = '/workspace/project';
export const PATH_PREFIX = 'export PATH="$HOME/.npm-global/bin:$PATH" &&';
export const SANDBOX_IDLE_MINUTES = 15;

export type SandboxConfig = { githubToken: string; repoFullName: string; branch: string; emptyRepo?: boolean; reuseOnly?: boolean };
export type WorkspaceCommandResult = { exitCode: number; result?: string };
export type DevelopmentWorkspace = {
  id: string;
  workspace: Workspace;
  process: { executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSec?: number): Promise<WorkspaceCommandResult> };
  fs: { uploadFile(dataOrLocalPath: Buffer | string, absPath: string): Promise<void> };
};

const active = new Map<string, DevelopmentWorkspace>();
const secretValues = new Map<string, string>();
let runtime: OpenAiWorkspaceRuntime | null = null;

export function setDevelopmentSecret(grantId: string, value: string | null): void {
  if (value === null) secretValues.delete(grantId);
  else secretValues.set(grantId, value);
}

export function activeDevelopmentWorkspaceIds(): string[] { return [...active.keys()]; }

export async function stopDevelopmentWorkspaceById(id: string): Promise<void> {
  const sandbox = active.get(id);
  if (!sandbox) return;
  await sandbox.process.executeCommand('pkill -TERM -f "selvedge-turn-|selvedge-app" || true', undefined, undefined, 30).catch(() => undefined);
}

export type SandboxExecutionSnapshot = { observedAt: Date; changedFiles: string[]; diffSummary: string | null };
const CHECKPOINT_PATH = '/tmp/selvedge-worktree-checkpoint.tgz';
const CHECKPOINT_MAX_BYTES = 25 * 1024 * 1024;

/** Persist the current worktree without committing or pushing it. */
export async function checkpointSandbox(db: Db, orgId: string, projectId: string): Promise<boolean> {
  const build = await getBuild(db, orgId, projectId);
  const sandbox = build?.sandboxId ? active.get(build.sandboxId) : null;
  if (!sandbox) return false;
  const packed = await sandbox.process.executeCommand(
    `cd ${WORKDIR} && tar -czf ${CHECKPOINT_PATH} --exclude=.git --exclude=node_modules --exclude=.env --exclude=.env.local --exclude=.env.development.local --exclude=.env.production.local --exclude=.env.test.local .`,
    undefined,
    undefined,
    120,
  );
  if (packed.exitCode !== 0) return false;
  const archive = await sandbox.workspace.download(CHECKPOINT_PATH);
  await sandbox.process.executeCommand(`rm -f ${CHECKPOINT_PATH}`, undefined, undefined, 15).catch(() => undefined);
  if (archive.byteLength > CHECKPOINT_MAX_BYTES) {
    throw new Error('The unshipped workspace is larger than the 25 MB recovery limit. Ship or remove generated files before continuing.');
  }
  await setBuild(db, orgId, projectId, {
    checkpointArchiveBase64: Buffer.from(archive).toString('base64'),
    checkpointSha256: createHash('sha256').update(archive).digest('hex'),
    checkpointBytes: archive.byteLength,
    checkpointCreatedAt: new Date(),
  });
  return true;
}

async function restoreCheckpoint(db: Db, orgId: string, projectId: string, sandbox: DevelopmentWorkspace): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.checkpointArchiveBase64) return;
  const archive = Buffer.from(build.checkpointArchiveBase64, 'base64');
  const sha = createHash('sha256').update(archive).digest('hex');
  if (build.checkpointSha256 && sha !== build.checkpointSha256) throw new Error('workspace checkpoint integrity check failed');
  await sandbox.workspace.upload(CHECKPOINT_PATH, archive);
  const restored = await sandbox.process.executeCommand(
    `cd ${WORKDIR} && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -xzf ${CHECKPOINT_PATH} -C ${WORKDIR} && rm -f ${CHECKPOINT_PATH}`,
    undefined,
    undefined,
    120,
  );
  if (restored.exitCode !== 0) throw new Error('workspace checkpoint could not be restored');
}

export async function publishPreviewRef(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
): Promise<string> {
  const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
  const ref = `selvedge-preview/${projectId}-${Date.now().toString(36)}`;
  const helper = shellQuote('!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f');
  const command = [
    `cd ${WORKDIR}`,
    'git add -A',
    'tree=$(git write-tree)',
    'parent=$(git rev-parse HEAD)',
    `commit=$(printf %s ${shellQuote('Selvedge disposable preview')} | git commit-tree "$tree" -p "$parent")`,
    `git -c credential.helper=${helper} push origin "$commit:refs/heads/${ref}"`,
    'git reset -q HEAD',
  ].join(' && ');
  const result = await sandbox.process.executeCommand(command, undefined, { GITHUB_TOKEN: cfg.githubToken }, 300);
  if (result.exitCode !== 0) throw new Error('could not publish the disposable preview source');
  return ref;
}

export async function deletePreviewRef(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  ref: string,
): Promise<void> {
  if (!/^selvedge-preview\/[A-Za-z0-9._-]+$/.test(ref)) throw new Error('invalid preview ref');
  const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
  const helper = shellQuote('!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f');
  const result = await sandbox.process.executeCommand(
    `cd ${WORKDIR} && git -c credential.helper=${helper} push origin --delete ${shellQuote(ref)}`,
    undefined,
    { GITHUB_TOKEN: cfg.githubToken },
    120,
  );
  if (result.exitCode !== 0) throw new Error('could not remove the disposable preview source');
}

export async function inspectSandboxWorktree(db: Db, orgId: string, projectId: string): Promise<SandboxExecutionSnapshot | null> {
  const build = await getBuild(db, orgId, projectId);
  const sandbox = build?.sandboxId ? active.get(build.sandboxId) : null;
  if (!sandbox) return null;
  try {
    const result = await sandbox.process.executeCommand(
      `cd ${WORKDIR} && { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u; echo __SELVDG_DIFF__; git diff --stat; git diff --cached --stat`,
      undefined,
      undefined,
      30,
    );
    if (result.exitCode !== 0) return null;
    const [names = '', summary = ''] = (result.result ?? '').split('__SELVDG_DIFF__\n', 2);
    return {
      observedAt: new Date(),
      changedFiles: names.split('\n').map((path) => path.trim()).filter(Boolean).slice(0, 40),
      diffSummary: summary.trim().slice(0, 12_000) || null,
    };
  } catch {
    return null;
  }
}

export function isSandboxCapacityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /total disk limit exceeded|maximum allowed:\s*\d+\s*GiB|free up available storage|capacity|quota/i.test(text);
}

/** OpenAI uses both 404 and a provider-specific "expired" API error for a gone container. */
export function isExpiredWorkspaceError(error: unknown): boolean {
  if (!(error instanceof OpenAiWorkspaceApiError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 400 && error.status !== 409) return false;
  return /(?:container|workspace).*(?:expired|not found)|(?:expired|not found).*(?:container|workspace)/i.test(
    `${error.code ?? ''} ${error.message}`,
  );
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export function developmentWorkspaceRuntime(): OpenAiWorkspaceRuntime {
  if (runtime) return runtime;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const relay = getPreviewRelay();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for Development Workspaces');
  if (!relay) throw new Error('PREVIEW_RELAY_SIGNING_SECRET and PREVIEW_RELAY_PUBLIC_ORIGIN are required for Development Workspaces');
  runtime = new OpenAiWorkspaceRuntime({
    client: new OpenAiWorkspaceClient({ apiKey }), model: process.env.WORKSPACE_MODEL?.trim() || 'gpt-5.4', relay: relay.sessions,
    resolveSecretGrant: async (grant) => {
      const value = secretValues.get(grant.id);
      if (!value) throw new Error(`secret grant ${grant.id} is no longer available`);
      return value;
    },
    captureBrowserEvidence: async () => ({ screenshotArtifactIds: [], consoleErrors: [], failedRequests: [] }),
  });
  return runtime;
}

async function executeWithEnvironment(workspace: Workspace, command: string, timeoutSec: number, cwd?: string, env?: Record<string, string>): Promise<WorkspaceExecResult> {
  if (!env || Object.keys(env).length === 0) return workspace.exec({ command, cwd, timeoutSeconds: timeoutSec });
  for (const name of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid command environment name: ${name}`);
  const configPath = `/mnt/data/selvedge-command-env-${randomBytes(8).toString('hex')}.sh`;
  await workspace.upload(configPath, Buffer.from(Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')));
  return workspace.exec({ command: `set -a; . ${shellQuote(configPath)}; rm -f ${shellQuote(configPath)}; set +a; ${command}`, cwd, timeoutSeconds: timeoutSec });
}

export function adaptDevelopmentWorkspace(workspace: Workspace): DevelopmentWorkspace {
  return {
    id: workspace.id,
    workspace,
    process: { async executeCommand(command, cwd, env, timeoutSec = 60) {
      const result = await executeWithEnvironment(workspace, command, timeoutSec, cwd, env);
      return { exitCode: result.exitCode, result: [result.stdout, result.stderr].filter(Boolean).join('\n') };
    } },
    fs: { async uploadFile(dataOrLocalPath, absPath) {
      await workspace.upload(absPath, typeof dataOrLocalPath === 'string' ? await readFile(dataOrLocalPath) : dataOrLocalPath);
    } },
  };
}

function workspaceInput(orgId: string, projectId: string, cfg: SandboxConfig, snapshot?: { filename: string; data: Uint8Array }): CreateWorkspaceInput {
  const gitGrantId = `github:${orgId}:${projectId}`;
  return {
    orgId, projectId, purpose: 'development',
    source: { kind: 'git', repository: `https://github.com/${cfg.repoFullName}.git`, ref: cfg.branch, credentialGrant: gitGrantId, empty: cfg.emptyRepo, snapshot },
    ttlMinutes: 24 * 60, idleStopMinutes: SANDBOX_IDLE_MINUTES,
    network: { default: 'deny', allowedHosts: ['github.com', 'api.github.com', 'registry.npmjs.org', 'api.anthropic.com', 'api.openai.com'] },
    secrets: [{ id: gitGrantId, name: 'GITHUB_TOKEN', exposure: 'command' }],
    labels: { orgId, projectId },
  };
}

async function fetchRepositorySnapshot(cfg: SandboxConfig): Promise<{ filename: string; data: Uint8Array } | undefined> {
  if (cfg.emptyRepo) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repoFullName)) throw new Error('invalid GitHub repository name');
  const response = await fetch(`https://api.github.com/repos/${cfg.repoFullName}/tarball/${encodeURIComponent(cfg.branch)}`, {
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Selvedge',
    },
  });
  if (!response.ok) throw new Error(`could not prepare repository snapshot (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > 100 * 1024 * 1024) throw new Error('repository snapshot exceeds the 100 MB workspace import limit');
  return { filename: `selvedge-source-${randomBytes(8).toString('hex')}.tar.gz`, data };
}

async function create(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<DevelopmentWorkspace> {
  const gitGrantId = `github:${orgId}:${projectId}`;
  secretValues.set(gitGrantId, cfg.githubToken);
  try {
    const snapshot = await fetchRepositorySnapshot(cfg);
    const workspace = await developmentWorkspaceRuntime().createWorkspace(workspaceInput(orgId, projectId, cfg, snapshot));
    const sandbox = adaptDevelopmentWorkspace(workspace);
    active.set(workspace.id, sandbox);
    await restoreCheckpoint(db, orgId, projectId, sandbox);
    await workspace.exec({ command: 'git config user.name "Selvedge" && git config user.email "selvedge@users.noreply.github.com"', cwd: WORKDIR, timeoutSeconds: 30 });
    await setBuild(db, orgId, projectId, { sandboxId: workspace.id, repoFullName: cfg.repoFullName, branch: cfg.branch });
    await openSandboxRun(db, orgId, projectId, workspace.id).catch((error) => console.error('could not open workspace metering segment:', error));
    return sandbox;
  } catch (error) {
    secretValues.delete(gitGrantId);
    throw error;
  }
}

export async function ensureSandbox(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<DevelopmentWorkspace> {
  const build = await getBuild(db, orgId, projectId);
  if (build?.sandboxId) {
    const existing = active.get(build.sandboxId);
    if (existing) {
      try {
        // OpenAI containers expire independently of this process. An object in
        // the local map is therefore only a handle, not proof that the remote
        // workspace still exists. Validate it before returning; otherwise a
        // preview or follow-up turn keeps calling a deleted container forever.
        await existing.workspace.inspect();
        secretValues.set(`github:${orgId}:${projectId}`, cfg.githubToken);
        await openSandboxRun(db, orgId, projectId, existing.id).catch(() => undefined);
        return existing;
      } catch (error) {
        if (!isExpiredWorkspaceError(error)) throw error;
        active.delete(build.sandboxId);
        await closeSandboxRun(db, build.sandboxId, 'failed').catch(() => null);
        await clearSandbox(db, orgId, projectId, Boolean(build.checkpointArchiveBase64));
        if (cfg.reuseOnly) throw new Error('The old workshop copy has expired. Connect the repository to create a fresh preview.');
      }
    }
    // The active-map branch may have just proved this id expired and cleared
    // the record. Only attempt a reconnect while the original id is still the
    // persisted workspace for this project.
    if ((await getBuild(db, orgId, projectId))?.sandboxId === build.sandboxId) {
      setDevelopmentSecret(`github:${orgId}:${projectId}`, cfg.githubToken);
      try {
        const workspace = await developmentWorkspaceRuntime().reconnectWorkspaceWithContext(
          build.sandboxId,
          workspaceInput(orgId, projectId, cfg),
        );
        const reconnected = adaptDevelopmentWorkspace(workspace);
        active.set(build.sandboxId, reconnected);
        await openSandboxRun(db, orgId, projectId, reconnected.id).catch(() => undefined);
        return reconnected;
      } catch (error) {
        if (!isExpiredWorkspaceError(error)) throw error;
        await clearSandbox(db, orgId, projectId, Boolean(build.checkpointArchiveBase64));
        if (cfg.reuseOnly) throw new Error('The old workshop copy has expired. Connect the repository to create a fresh preview.');
      }
    }
  }
  return create(db, orgId, projectId, cfg);
}

export async function stopSandbox(db: Db, orgId: string, projectId: string): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  const sandbox = build?.sandboxId ? active.get(build.sandboxId) : null;
  if (sandbox) await sandbox.process.executeCommand('pkill -TERM -f "selvedge-turn-|selvedge-app" || true', undefined, undefined, 30).catch(() => undefined);
  if (build?.sandboxId) await closeSandboxRun(db, build.sandboxId, 'user_stop').catch(() => null);
}

export async function deleteSandbox(db: Db, orgId: string, projectId: string): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (build?.sandboxId) {
    const sandbox = active.get(build.sandboxId);
    if (sandbox) await sandbox.workspace.destroy().catch(() => undefined);
    active.delete(build.sandboxId);
    await closeSandboxRun(db, build.sandboxId, 'completed').catch(() => null);
  }
  secretValues.delete(`github:${orgId}:${projectId}`);
  await clearSandbox(db, orgId, projectId);
}
