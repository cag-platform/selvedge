import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type {
  BrowserEvidence, CreateWorkspaceInput, SecretGrant, Workspace, WorkspaceCapabilities,
  WorkspaceExecRequest, WorkspaceExecResult, WorkspaceHandle, WorkspacePreview,
  WorkspaceProcess, WorkspaceProcessRequest, WorkspaceRuntime,
} from '../types.js';
import { previewConnectorSource, PREVIEW_CONNECTOR_FILENAME } from '../relay/connector.js';
import type { PreviewRelaySessions } from '../relay/session.js';
import { OpenAiWorkspaceApiError, OpenAiWorkspaceClient, type OpenAiMemoryLimit } from './client.js';

const encoder = new TextEncoder();
const EXIT_MARKER = '__SELVEDGE_EXIT__=';

export type OpenAiWorkspaceRuntimeOptions = {
  client: OpenAiWorkspaceClient;
  model: string;
  relay: PreviewRelaySessions;
  memoryLimit?: OpenAiMemoryLimit;
  /** Resolve a grant at execution time. Values are never placed in model input. */
  resolveSecretGrant: (grant: SecretGrant) => Promise<string>;
  captureBrowserEvidence: (preview: WorkspacePreview, path?: string) => Promise<BrowserEvidence>;
};

type WorkspaceMetadata = {
  orgId: string;
  projectId: string;
  grants: Map<string, SecretGrant>;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function repositoryHostname(repository: string): string {
  try { return new URL(repository).hostname; }
  catch {
    const scpStyle = /^[^@]+@([^:]+):/.exec(repository);
    if (scpStyle?.[1]) return scpStyle[1];
    throw new Error('repository must be an HTTPS, SSH, or git SCP-style URL');
  }
}

function parseExit(stdout: string): { exitCode: number; stdout: string } {
  const match = new RegExp(`(?:^|\\n)${EXIT_MARKER}(\\d+)(?:\\n|$)`).exec(stdout);
  if (!match) return { exitCode: 1, stdout };
  return { exitCode: Number(match[1]), stdout: stdout.replace(match[0], match[0].startsWith('\n') ? '\n' : '') };
}

function assertContainerUsable(container: { status: string }): void {
  if (container.status === 'expired') {
    throw new OpenAiWorkspaceApiError(409, 'container_expired', 'Container has expired.');
  }
}

class OpenAiWorkspace implements Workspace {
  readonly capabilities: WorkspaceCapabilities = {
    longRunningProcesses: true,
    authenticatedPreview: true,
    browserAutomation: true,
    enforceableNetworkPolicy: true,
    commandScopedSecrets: true,
  };

  private state: WorkspaceHandle['state'] = 'ready';
  private readonly previews = new Map<string, WorkspacePreview>();

  constructor(
    readonly id: string,
    private readonly metadata: WorkspaceMetadata,
    private readonly options: OpenAiWorkspaceRuntimeOptions,
  ) {}

  async inspect(): Promise<WorkspaceHandle> {
    if (this.state === 'destroyed') return { id: this.id, state: this.state };
    const container = await this.options.client.retrieveContainer(this.id);
    assertContainerUsable(container);
    return { id: this.id, state: container.status === 'running' ? 'ready' : 'stopped' };
  }

  async exec(request: WorkspaceExecRequest): Promise<WorkspaceExecResult> {
    const env: Record<string, string> = {};
    for (const grantId of request.secretGrants ?? []) {
      const grant = this.metadata.grants.get(grantId);
      if (!grant) throw new Error(`unknown secret grant: ${grantId}`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(grant.name)) throw new Error(`invalid secret environment name: ${grant.name}`);
      if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) throw new Error(`expired secret grant: ${grantId}`);
      env[grant.name] = await this.options.resolveSecretGrant(grant);
    }

    let secretPath: string | null = null;
    let prefix = '';
    if (Object.keys(env).length) {
      const uploaded = await this.options.client.uploadFile(
        this.id,
        `selvedge-env-${randomBytes(8).toString('hex')}.sh`,
        encoder.encode(Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')),
      );
      secretPath = uploaded.path;
      prefix = `set -a; . ${shellQuote(uploaded.path)}; rm -f ${shellQuote(uploaded.path)}; set +a; `;
    }

    const cwd = request.cwd ? `cd ${shellQuote(request.cwd)} && ` : '';
    const wrapped = `${prefix}${cwd}{ ${request.command}; }; code=$?; printf '\\n${EXIT_MARKER}%s\\n' "$code"`;
    try {
      const result = await this.options.client.runHostedShell({
        containerId: this.id,
        model: this.options.model,
        prompt: `Execute this shell command exactly once in the attached container. Do not rewrite it or expose file contents. Return the shell result. Command:\n${wrapped}`,
      });
      const parsed = parseExit(result.stdout);
      return { exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: result.stderr };
    } finally {
      if (secretPath) {
        await this.options.client.runHostedShell({
          containerId: this.id,
          model: this.options.model,
          prompt: `Delete this temporary credential file if it still exists: ${shellQuote(secretPath)}`,
        }).catch(() => undefined);
      }
    }
  }

  async startProcess(request: WorkspaceProcessRequest): Promise<WorkspaceProcess> {
    const processId = `process_${randomBytes(12).toString('hex')}`;
    const command = `mkdir -p /tmp/selvedge-processes; nohup sh -lc ${shellQuote(request.command)} >${shellQuote(`/tmp/selvedge-processes/${processId}.log`)} 2>&1 & echo $! >${shellQuote(`/tmp/selvedge-processes/${processId}.pid`)}`;
    const result = await this.exec({ ...request, command, timeoutSeconds: 30 });
    if (result.exitCode !== 0) throw new Error(`could not start workspace process: ${result.stderr || result.stdout}`);
    return { id: processId, name: request.name };
  }

  async stopProcess(processId: string): Promise<void> {
    if (!/^process_[a-f0-9]+$/.test(processId)) throw new Error('invalid process id');
    await this.exec({ command: `test ! -f /tmp/selvedge-processes/${processId}.pid || kill "$(cat /tmp/selvedge-processes/${processId}.pid)"`, timeoutSeconds: 30 });
  }

  async upload(path: string, data: Uint8Array): Promise<void> {
    const uploaded = await this.options.client.uploadFile(this.id, basename(path), data);
    if (uploaded.path === path) return;
    const result = await this.exec({ command: `mkdir -p ${shellQuote(path.slice(0, Math.max(1, path.lastIndexOf('/'))))}; mv ${shellQuote(uploaded.path)} ${shellQuote(path)}`, timeoutSeconds: 30 });
    if (result.exitCode !== 0) throw new Error(`workspace upload failed: ${result.stderr || result.stdout}`);
  }

  async download(path: string): Promise<Uint8Array> {
    const filename = `selvedge-download-${randomBytes(8).toString('hex')}-${basename(path)}`;
    const stagedPath = `/mnt/data/${filename}`;
    const result = await this.exec({ command: `cp ${shellQuote(path)} ${shellQuote(stagedPath)}`, timeoutSeconds: 30 });
    if (result.exitCode !== 0) throw new Error(`workspace download failed: ${result.stderr || result.stdout}`);
    const file = (await this.options.client.listFiles(this.id)).find((candidate) => candidate.path === stagedPath);
    if (!file) throw new Error('staged workspace download was not found');
    try { return await this.options.client.downloadFile(this.id, file.id); }
    finally { await this.options.client.deleteFile(this.id, file.id).catch(() => undefined); }
  }

  async exposePreview(input: { port: number; ttlMinutes: number }): Promise<WorkspacePreview> {
    const session = this.options.relay.create({
      workspaceId: this.id, orgId: this.metadata.orgId, projectId: this.metadata.projectId,
      port: input.port, ttlMinutes: input.ttlMinutes,
    });
    const source = await this.options.client.uploadFile(this.id, PREVIEW_CONNECTOR_FILENAME, encoder.encode(previewConnectorSource()));
    const config = await this.options.client.uploadFile(this.id, `selvedge-relay-${session.id}.json`, encoder.encode(JSON.stringify({
      url: session.connectorUrl.replace(/^https:/, 'wss:'), token: session.connectorToken, port: input.port,
    })));
    const connector = await this.startProcess({
      name: `preview:${session.id}`,
      command: `node ${shellQuote(source.path)} ${shellQuote(config.path)}`,
    });
    const preview = { id: session.id, port: input.port, url: session.previewUrl, expiresAt: session.expiresAt };
    this.previews.set(session.id, preview);
    void connector;
    return preview;
  }

  async captureBrowserEvidence(input: { previewId: string; path?: string }): Promise<BrowserEvidence> {
    const preview = this.previews.get(input.previewId);
    if (!preview) throw new Error('unknown workspace preview');
    return this.options.captureBrowserEvidence(preview, input.path);
  }

  async stop(): Promise<void> { await this.destroy(); }

  async destroy(): Promise<void> {
    if (this.state === 'destroyed') return;
    this.state = 'destroying';
    await this.options.client.deleteContainer(this.id);
    this.state = 'destroyed';
  }
}

export class OpenAiWorkspaceRuntime implements WorkspaceRuntime {
  private readonly metadata = new Map<string, WorkspaceMetadata>();
  constructor(private readonly options: OpenAiWorkspaceRuntimeOptions) {}

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const relayHost = new URL(this.options.relay.origin).hostname;
    const repositoryHost = repositoryHostname(input.source.repository);
    const allowedDomains = [...new Set([...input.network.allowedHosts, relayHost, repositoryHost])];
    const container = await this.options.client.createContainer({
      name: `selvedge-${input.projectId}`.slice(0, 64), expiresAfterMinutes: input.ttlMinutes,
      memoryLimit: this.options.memoryLimit ?? '4g',
      networkPolicy: input.network.default === 'deny'
        ? { type: 'allowlist', allowed_domains: allowedDomains }
        : { type: 'allowlist', allowed_domains: allowedDomains },
    });
    const metadata = { orgId: input.orgId, projectId: input.projectId, grants: new Map(input.secrets.map((grant) => [grant.id, grant])) };
    this.metadata.set(container.id, metadata);
    const workspace = new OpenAiWorkspace(container.id, metadata, this.options);
    try {
      const credentialGrant = input.source.credentialGrant
        ? metadata.grants.get(input.source.credentialGrant)
        : undefined;
      if (input.source.credentialGrant && !credentialGrant) throw new Error('repository credential grant is unknown');
      if (credentialGrant && credentialGrant.name !== 'GITHUB_TOKEN') {
        throw new Error('GitHub repository credential grant must expose GITHUB_TOKEN');
      }
      let cloneCommand: string;
      let cloneSecretGrants: string[] | undefined;
      if (input.source.snapshot) {
        const snapshot = await this.options.client.uploadFile(
          container.id,
          input.source.snapshot.filename,
          input.source.snapshot.data,
        );
        cloneCommand = [
          'mkdir -p /workspace/project',
          `tar -xzf ${shellQuote(snapshot.path)} -C /workspace/project --strip-components=1`,
          'cd /workspace/project',
          'git init',
          `git checkout -b ${shellQuote(input.source.ref)}`,
          `git remote add origin ${shellQuote(input.source.repository)}`,
          'git add -A',
          `git -c user.name=${shellQuote('Selvedge')} -c user.email=${shellQuote('selvedge@users.noreply.github.com')} commit -m ${shellQuote('Imported source snapshot')}`,
          `rm -f ${shellQuote(snapshot.path)}`,
        ].join(' && ');
      } else {
        const credentialHelper = credentialGrant
          ? `-c credential.helper=${shellQuote('!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f')} `
          : '';
        cloneCommand = input.source.empty
          ? `mkdir -p /workspace && git ${credentialHelper}clone ${shellQuote(input.source.repository)} /workspace/project && cd /workspace/project && git checkout -b ${shellQuote(input.source.ref)}`
          : `mkdir -p /workspace && git ${credentialHelper}clone --single-branch --branch ${shellQuote(input.source.ref)} ${shellQuote(input.source.repository)} /workspace/project`;
        cloneSecretGrants = input.source.credentialGrant ? [input.source.credentialGrant] : undefined;
      }
      const clone = await workspace.exec({
        command: cloneCommand,
        timeoutSeconds: 300,
        ...(cloneSecretGrants ? { secretGrants: cloneSecretGrants } : {}),
      });
      if (clone.exitCode !== 0) throw new Error(`repository checkout failed: ${clone.stderr || clone.stdout}`);
      return workspace;
    } catch (error) {
      await workspace.destroy().catch(() => undefined);
      this.metadata.delete(container.id);
      throw error;
    }
  }

  async reconnectWorkspace(workspaceId: string): Promise<Workspace> {
    const metadata = this.metadata.get(workspaceId);
    if (!metadata) throw new Error('workspace metadata is unavailable; persist it before enabling reconnect across restarts');
    assertContainerUsable(await this.options.client.retrieveContainer(workspaceId));
    return new OpenAiWorkspace(workspaceId, metadata, this.options);
  }

  /** Rehydrate provider-neutral metadata held by Selvedge after an API restart. */
  async reconnectWorkspaceWithContext(workspaceId: string, input: CreateWorkspaceInput): Promise<Workspace> {
    assertContainerUsable(await this.options.client.retrieveContainer(workspaceId));
    const metadata = {
      orgId: input.orgId,
      projectId: input.projectId,
      grants: new Map(input.secrets.map((grant) => [grant.id, grant])),
    };
    this.metadata.set(workspaceId, metadata);
    return new OpenAiWorkspace(workspaceId, metadata, this.options);
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    await this.options.client.deleteContainer(workspaceId);
    this.metadata.delete(workspaceId);
  }
}
