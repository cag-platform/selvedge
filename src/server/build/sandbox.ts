import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { getBuild, setBuild, clearSandbox } from './store.js';
import type { CreateWorkspaceInput, SecretGrant, Workspace, WorkspaceExecResult } from '../workspace/types.js';
import { OpenAiWorkspaceApiError, OpenAiWorkspaceClient } from '../workspace/openai/client.js';
import { OpenAiWorkspaceRuntime } from '../workspace/openai/runtime.js';
import { BlaxelWorkspaceRuntime } from '../workspace/blaxel/runtime.js';
import { getPreviewRelay } from '../workspace/relay/factory.js';
import { closeSandboxRun, openSandboxRun } from './metering.js';
import { unzipSync } from 'fflate';
import { createPreviewRefWithToken } from '../connectors/github/pushFiles.js';
import { WEB_WORKSPACE_REQUIREMENTS, type WorkspaceRequirements } from '../workspace/requirements.js';

export const WORKDIR = '/workspace/project';
export const PATH_PREFIX = 'export PATH="$HOME/.npm-global/bin:$PATH" &&';
export const SANDBOX_IDLE_MINUTES = 15;

export type SandboxConfig = { githubToken: string; repoFullName: string; branch: string; emptyRepo?: boolean; reuseOnly?: boolean; requirements?: WorkspaceRequirements };
export type WorkspaceCommandResult = { exitCode: number; result?: string };
export type DevelopmentWorkspace = {
  id: string;
  workspace: Workspace;
  process: { executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSec?: number): Promise<WorkspaceCommandResult> };
  fs: { uploadFile(dataOrLocalPath: Buffer | string, absPath: string): Promise<void> };
};

const active = new Map<string, DevelopmentWorkspace>();
const secretValues = new Map<string, string>();
type DevelopmentRuntime = {
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  reconnectWorkspaceWithContext(workspaceId: string, input: CreateWorkspaceInput): Promise<Workspace>;
  destroyWorkspace(workspaceId: string): Promise<void>;
};

let runtime: DevelopmentRuntime | null = null;

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
): Promise<{ ref: string; commitSha: string }> {
  const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
  const ref = `selvedge-preview/${projectId}-${Date.now().toString(36)}`;
  const archivePath = '/tmp/selvedge-preview-source.zip';
  const script = `import os, zipfile\nroot=${JSON.stringify(WORKDIR)}\nout=${JSON.stringify(archivePath)}\nskip={'.git','node_modules','.env','.env.local','.env.development.local','.env.production.local','.env.test.local'}\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for base,dirs,names in os.walk(root):\n  dirs[:]=[d for d in dirs if d not in skip]\n  for name in names:\n   path=os.path.join(base,name)\n   rel=os.path.relpath(path,root)\n   if rel not in skip and not os.path.islink(path): z.write(path,rel)\n`;
  // Hosted container file attachments can disappear between the upload call
  // and the next model-backed shell turn. The fixed script contains no user
  // input beyond JSON-escaped paths, so carry it inline as base64 and avoid
  // relying on that transient attachment boundary.
  const encodedScript = Buffer.from(script).toString('base64');
  const packed = await sandbox.process.executeCommand(
    `python3 -c ${shellQuote(`import base64;exec(base64.b64decode(${JSON.stringify(encodedScript)}))`)}`,
    undefined,
    undefined,
    180,
  );
  if (packed.exitCode !== 0) throw new Error('could not package the disposable preview source');
  const entries = unzipSync(await sandbox.workspace.download(archivePath));
  const files = Object.entries(entries).filter(([path]) => !path.endsWith('/')).map(([path, bytes]) => ({ path, bytes }));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (files.length > 1_000 || totalBytes > 50 * 1024 * 1024) throw new Error('the disposable preview source exceeds its safe GitHub upload limit');
  const pushed = await createPreviewRefWithToken(cfg.githubToken, cfg.repoFullName, files, ref);
  await sandbox.process.executeCommand(`rm -f ${archivePath}`, undefined, undefined, 30).catch(() => undefined);
  return { ref, commitSha: pushed.commitSha };
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

/** Providers report a gone workspace differently; normalize that into one recoverable condition. */
export function isExpiredWorkspaceError(error: unknown): boolean {
  if (error instanceof OpenAiWorkspaceApiError) {
    if (error.status === 404) return true;
    if (error.status !== 400 && error.status !== 409) return false;
    return /(?:container|workspace).*(?:expired|not found)|(?:expired|not found).*(?:container|workspace)/i.test(
      `${error.code ?? ''} ${error.message}`,
    );
  }
  return /(?:sandbox|workspace).*(?:terminated|expired|not found)|(?:terminated|expired|not found).*(?:sandbox|workspace)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export function developmentWorkspaceRuntime(): DevelopmentRuntime {
  if (runtime) return runtime;
  const relay = getPreviewRelay();
  if (!relay) throw new Error('PREVIEW_RELAY_SIGNING_SECRET and PREVIEW_RELAY_PUBLIC_ORIGIN are required for Development Workspaces');
  const common = {
    relay: relay.sessions,
    resolveSecretGrant: async (grant: SecretGrant) => {
      const value = secretValues.get(grant.id);
      if (!value) throw new Error(`secret grant ${grant.id} is no longer available`);
      return value;
    },
    captureBrowserEvidence: async () => ({ screenshotArtifactIds: [], consoleErrors: [], failedRequests: [] }),
  };
  const provider = process.env.WORKSPACE_PROVIDER?.trim().toLowerCase() || 'openai';
  if (provider !== 'openai' && provider !== 'blaxel') throw new Error(`unsupported workspace provider: ${provider}`);
  if (provider === 'blaxel') {
    if (!process.env.BL_WORKSPACE?.trim() || !process.env.BL_API_KEY?.trim()) {
      throw new Error('BL_WORKSPACE and BL_API_KEY are required for Blaxel Development Workspaces');
    }
    const memory = Number(process.env.BLAXEL_MEMORY_MB ?? 4096);
    runtime = new BlaxelWorkspaceRuntime({
      ...common,
      image: process.env.BLAXEL_IMAGE?.trim() || 'blaxel/ts-app:latest',
      memoryMb: Number.isFinite(memory) && memory >= 1024 ? memory : 4096,
      region: process.env.BL_REGION?.trim() || undefined,
    });
  } else {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI Development Workspaces');
    runtime = new OpenAiWorkspaceRuntime({
      ...common,
      client: new OpenAiWorkspaceClient({ apiKey }),
      model: process.env.WORKSPACE_MODEL?.trim() || 'gpt-5.4',
    });
  }
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
    requirements: cfg.requirements ?? WEB_WORKSPACE_REQUIREMENTS,
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
