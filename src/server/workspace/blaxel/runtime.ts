import { createHash, randomBytes } from 'node:crypto';
import { SandboxInstance } from '@blaxel/core';
import type {
  BrowserEvidence, CreateWorkspaceInput, SecretGrant, Workspace, WorkspaceCapabilities,
  WorkspaceExecRequest, WorkspaceExecResult, WorkspaceHandle, WorkspacePreview,
  WorkspaceProcess, WorkspaceProcessRequest, WorkspaceRuntime,
} from '../types.js';
import { supportsWorkspaceRequirements } from '../capabilities.js';
import { previewConnectorSource, PREVIEW_CONNECTOR_FILENAME } from '../relay/connector.js';
import type { PreviewRelaySessions } from '../relay/session.js';

export type BlaxelWorkspaceRuntimeOptions = {
  relay: PreviewRelaySessions;
  image?: string;
  memoryMb?: number;
  region?: string;
  resolveSecretGrant: (grant: SecretGrant) => Promise<string>;
  captureBrowserEvidence: (preview: WorkspacePreview, path?: string) => Promise<BrowserEvidence>;
};

type WorkspaceMetadata = {
  orgId: string;
  projectId: string;
  grants: Map<string, SecretGrant>;
};

function sandboxName(input: CreateWorkspaceInput): string {
  // Blaxel caps metadata.name at 49 characters. `selvedge-` + 27 readable
  // characters + `-` + the 12-character unique suffix fits exactly.
  const readable = input.projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 27) || 'project';
  const unique = createHash('sha256').update(`${input.orgId}:${input.projectId}:${randomBytes(8).toString('hex')}`).digest('hex').slice(0, 12);
  return `selvedge-${readable}-${unique}`;
}

function repositoryHostname(repository: string): string {
  try { return new URL(repository).hostname; }
  catch {
    const match = /^[^@]+@([^:]+):/.exec(repository);
    if (match?.[1]) return match[1];
    throw new Error('repository must be an HTTPS, SSH, or git SCP-style URL');
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isTransientSandboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:502|503|504)\b|ECONNRESET|fetch failed|socket hang up/i.test(message);
}

async function withTransientSandboxRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (!isTransientSandboxError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function stateOf(sandbox: SandboxInstance): WorkspaceHandle['state'] {
  if (sandbox.status === 'FAILED' || sandbox.status === 'TERMINATED') return 'failed';
  if (sandbox.status === 'DELETING' || sandbox.status === 'DEACTIVATING') return 'destroying';
  if (sandbox.status === 'BUILDING' || sandbox.status === 'DEPLOYING' || sandbox.status === 'UPLOADING') return 'creating';
  return sandbox.status === 'DEACTIVATED' || sandbox.spec.enabled === false
    ? 'stopped'
    : 'ready';
}

class BlaxelWorkspace implements Workspace {
  readonly capabilities: WorkspaceCapabilities = {
    longRunningProcesses: true,
    authenticatedPreview: true,
    // Browser capture remains Selvedge-owned and is injected into this adapter.
    browserAutomation: true,
    enforceableNetworkPolicy: true,
    commandScopedSecrets: true,
    platforms: ['linux'],
    nativeTools: [],
  };

  private readonly previews = new Map<string, WorkspacePreview>();

  constructor(
    readonly id: string,
    private sandbox: SandboxInstance,
    private readonly metadata: WorkspaceMetadata,
    private readonly options: BlaxelWorkspaceRuntimeOptions,
  ) {}

  private async environment(grantIds: string[] = []): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const grantId of grantIds) {
      const grant = this.metadata.grants.get(grantId);
      if (!grant) throw new Error(`unknown secret grant: ${grantId}`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(grant.name)) throw new Error(`invalid secret environment name: ${grant.name}`);
      if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) throw new Error(`expired secret grant: ${grantId}`);
      env[grant.name] = await this.options.resolveSecretGrant(grant);
    }
    return env;
  }

  async inspect(): Promise<WorkspaceHandle> {
    this.sandbox = await SandboxInstance.get(this.id);
    if (this.sandbox.status === 'TERMINATED') {
      throw new Error(`Blaxel sandbox ${this.id} is terminated`);
    }
    if (this.sandbox.status === 'FAILED') {
      throw new Error(`Blaxel sandbox ${this.id} failed`);
    }
    return { id: this.id, state: stateOf(this.sandbox) };
  }

  async exec(request: WorkspaceExecRequest): Promise<WorkspaceExecResult> {
    const name = `selvedge-exec-${randomBytes(8).toString('hex')}`;
    const resultBase = `/tmp/${name}-${randomBytes(8).toString('hex')}`;
    const stdoutPath = `${resultBase}.stdout`;
    const stderrPath = `${resultBase}.stderr`;
    const exitPath = `${resultBase}.exit`;
    const started = await this.sandbox.process.exec({
      name,
      // Blaxel's process status, list, and wait endpoints can remain open after
      // a command has exited. Persist the result inside the sandbox and poll
      // the filesystem instead, so completion is entirely Selvedge-owned.
      // Braces intentionally avoid a subshell: agent turns launch their worker
      // with `nohup ... &` and must return immediately to the outer poller.
      command: `{ ${request.command}; code=$?; printf '%s' "$code" > ${shellQuote(exitPath)}; } > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`,
      workingDir: request.cwd,
      env: await this.environment(request.secretGrants),
      timeout: request.timeoutSeconds,
    });
    if (started.status === 'failed') {
      throw new Error(started.stderr || started.stdout || 'Blaxel could not start the command');
    }

    const readResult = async (path: string): Promise<string> => {
      const blob = await withTransientSandboxRetry(() => this.sandbox.fs.readBinary(path));
      return await blob.text();
    };
    const deadline = Date.now() + request.timeoutSeconds * 1_000;
    let exitCode: number | null = null;
    while (Date.now() < deadline) {
      try {
        const value = (await readResult(exitPath)).trim();
        if (/^\d+$/.test(value)) {
          exitCode = Number(value);
          break;
        }
      } catch {
        // The result file does not exist until the command is complete. Blaxel
        // may also briefly return a gateway error while a sandbox wakes.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (exitCode === null) {
      await this.sandbox.process.kill(started.pid || name).catch(() => undefined);
      throw new Error('Process did not finish in time');
    }
    return {
      exitCode,
      stdout: await readResult(stdoutPath).catch(() => ''),
      stderr: await readResult(stderrPath).catch(() => ''),
    };
  }

  async startProcess(request: WorkspaceProcessRequest): Promise<WorkspaceProcess> {
    const process = await this.sandbox.process.exec({
      name: request.name,
      command: request.command,
      workingDir: request.cwd,
      env: await this.environment(request.secretGrants),
      // A running process is snapshotted by Blaxel when the sandbox enters
      // standby. Do not force active compute merely because a dev server exists.
      keepAlive: false,
      timeout: 0,
    });
    if (process.status === 'failed') throw new Error(`could not start workspace process: ${process.stderr || process.stdout}`);
    return { id: process.pid || request.name, name: request.name };
  }

  async stopProcess(processId: string): Promise<void> {
    await this.sandbox.process.kill(processId);
  }

  async upload(path: string, data: Uint8Array): Promise<void> {
    const parent = path.slice(0, Math.max(1, path.lastIndexOf('/')));
    await withTransientSandboxRetry(() => this.sandbox.fs.mkdir(parent)).catch(() => undefined);
    await withTransientSandboxRetry(() => this.sandbox.fs.writeBinary(path, data));
  }

  async download(path: string): Promise<Uint8Array> {
    const blob = await withTransientSandboxRetry(() => this.sandbox.fs.readBinary(path));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async exposePreview(input: { port: number; ttlMinutes: number }): Promise<WorkspacePreview> {
    // Keep Selvedge's authenticated origin during the pilot. Native Blaxel
    // previews can replace this relay after product and iframe behavior pass.
    const session = this.options.relay.create({
      workspaceId: this.id,
      orgId: this.metadata.orgId,
      projectId: this.metadata.projectId,
      port: input.port,
      ttlMinutes: input.ttlMinutes,
    });
    await this.upload(`/tmp/${PREVIEW_CONNECTOR_FILENAME}`, new TextEncoder().encode(previewConnectorSource()));
    const configPath = `/tmp/selvedge-relay-${session.id}.json`;
    await this.upload(configPath, new TextEncoder().encode(JSON.stringify({
      url: session.pollUrl,
      token: session.connectorToken,
      port: input.port,
    })));
    await this.startProcess({
      name: `preview-${session.id}`,
      command: `node ${shellQuote(`/tmp/${PREVIEW_CONNECTOR_FILENAME}`)} ${shellQuote(configPath)}`,
    });
    const preview = { id: session.id, port: input.port, url: session.previewUrl, expiresAt: session.expiresAt };
    this.previews.set(session.id, preview);
    return preview;
  }

  async captureBrowserEvidence(input: { previewId: string; path?: string }): Promise<BrowserEvidence> {
    const preview = this.previews.get(input.previewId);
    if (!preview) throw new Error('unknown workspace preview');
    return this.options.captureBrowserEvidence(preview, input.path);
  }

  async stop(): Promise<void> {
    // Blaxel enters standby automatically after active connections and
    // keep-alive processes end. Do not destroy the resumable project computer.
    const processes = await this.sandbox.process.list();
    await Promise.all(processes.filter((process) => process.status === 'running').map((process) =>
      this.sandbox.process.stop(process.pid).catch(() => undefined),
    ));
  }

  async destroy(): Promise<void> {
    await this.sandbox.delete();
  }
}

export class BlaxelWorkspaceRuntime implements WorkspaceRuntime {
  private readonly metadata = new Map<string, WorkspaceMetadata>();
  readonly capabilities: WorkspaceCapabilities = {
    longRunningProcesses: true,
    authenticatedPreview: true,
    browserAutomation: true,
    enforceableNetworkPolicy: true,
    commandScopedSecrets: true,
    platforms: ['linux'],
    nativeTools: [],
  };

  constructor(private readonly options: BlaxelWorkspaceRuntimeOptions) {}

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    if (input.requirements && !supportsWorkspaceRequirements(this.capabilities, input.requirements)) {
      throw new Error(`workspace runtime does not support ${input.requirements.platform} projects`);
    }
    const relayHost = new URL(this.options.relay.origin).hostname;
    const allowedDomains = [...new Set([...input.network.allowedHosts, relayHost, repositoryHostname(input.source.repository)])];
    const sandbox = await SandboxInstance.create({
      name: sandboxName(input),
      image: this.options.image ?? 'blaxel/ts-app:latest',
      memory: this.options.memoryMb ?? 4096,
      ...(this.options.region ? { region: this.options.region } : {}),
      labels: { ...input.labels, orgId: input.orgId, projectId: input.projectId, purpose: input.purpose },
      lifecycle: {
        expirationPolicies: [
          { type: 'ttl-max-age', value: `${Math.max(1, Math.floor(input.ttlMinutes))}m`, action: 'delete' },
        ],
      },
      network: input.network.default === 'deny'
        ? { proxy: { allowedDomains, routing: [] } }
        : undefined,
    });
    await sandbox.wait();
    const metadata = { orgId: input.orgId, projectId: input.projectId, grants: new Map(input.secrets.map((grant) => [grant.id, grant])) };
    this.metadata.set(sandbox.metadata.name, metadata);
    const workspace = new BlaxelWorkspace(sandbox.metadata.name, sandbox, metadata, this.options);
    try {
      let command: string;
      let secretGrants: string[] | undefined;
      if (input.source.snapshot) {
        const snapshotPath = `/tmp/${input.source.snapshot.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        await workspace.upload(snapshotPath, input.source.snapshot.data);
        command = [
          'mkdir -p /workspace/project',
          `tar -xzf ${shellQuote(snapshotPath)} -C /workspace/project --strip-components=1`,
          'cd /workspace/project',
          'git init',
          `git checkout -b ${shellQuote(input.source.ref)}`,
          `git remote add origin ${shellQuote(input.source.repository)}`,
          'git add -A',
          `git -c user.name=${shellQuote('Selvedge')} -c user.email=${shellQuote('selvedge@users.noreply.github.com')} commit -m ${shellQuote('Imported source snapshot')}`,
          `rm -f ${shellQuote(snapshotPath)}`,
        ].join(' && ');
      } else {
        const grant = input.source.credentialGrant ? metadata.grants.get(input.source.credentialGrant) : undefined;
        if (input.source.credentialGrant && !grant) throw new Error('repository credential grant is unknown');
        const helper = grant ? `-c credential.helper=${shellQuote('!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f')} ` : '';
        command = input.source.empty
          ? `mkdir -p /workspace && git ${helper}clone ${shellQuote(input.source.repository)} /workspace/project && cd /workspace/project && git checkout -b ${shellQuote(input.source.ref)}`
          : `mkdir -p /workspace && git ${helper}clone --single-branch --branch ${shellQuote(input.source.ref)} ${shellQuote(input.source.repository)} /workspace/project`;
        secretGrants = input.source.credentialGrant ? [input.source.credentialGrant] : undefined;
      }
      const cloned = await workspace.exec({ command, timeoutSeconds: 300, ...(secretGrants ? { secretGrants } : {}) });
      if (cloned.exitCode !== 0) throw new Error(`repository checkout failed: ${cloned.stderr || cloned.stdout}`);
      return workspace;
    } catch (error) {
      await workspace.destroy().catch(() => undefined);
      this.metadata.delete(sandbox.metadata.name);
      throw error;
    }
  }

  async reconnectWorkspace(workspaceId: string): Promise<Workspace> {
    const metadata = this.metadata.get(workspaceId);
    if (!metadata) throw new Error('workspace metadata is unavailable; reconnect with persisted context');
    return new BlaxelWorkspace(workspaceId, await SandboxInstance.get(workspaceId), metadata, this.options);
  }

  async reconnectWorkspaceWithContext(workspaceId: string, input: CreateWorkspaceInput): Promise<Workspace> {
    const sandbox = await SandboxInstance.get(workspaceId);
    const metadata = { orgId: input.orgId, projectId: input.projectId, grants: new Map(input.secrets.map((grant) => [grant.id, grant])) };
    this.metadata.set(workspaceId, metadata);
    return new BlaxelWorkspace(workspaceId, sandbox, metadata, this.options);
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    await SandboxInstance.delete(workspaceId);
    this.metadata.delete(workspaceId);
  }
}
