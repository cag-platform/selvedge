/**
 * A Selvedge Development Workspace.
 *
 * This is the product boundary between Selvedge and the temporary compute used
 * to migrate, build and verify a customer's application. Nothing in this
 * contract exposes a compute vendor's SDK objects, preview URLs or lifecycle
 * vocabulary. Repositories, production hosting and databases remain in the
 * customer's accounts; a workspace is temporary and disposable.
 */

export type WorkspacePurpose = 'migration' | 'development' | 'verification' | 'repair';
export type WorkspaceState = 'creating' | 'ready' | 'stopped' | 'destroying' | 'destroyed' | 'failed';

export type WorkspaceSource = {
  kind: 'git';
  repository: string;
  ref: string;
  /** True when the remote has no commits yet; create the requested branch after cloning. */
  empty?: boolean;
  /** A command-scoped grant used for clone/fetch, never persisted in the checkout. */
  credentialGrant?: string;
  /** Optional server-fetched source snapshot, used when provider egress cannot safely clone. */
  snapshot?: { filename: string; data: Uint8Array };
};

export type NetworkPolicy = {
  /** New workspaces deny arbitrary egress unless the runtime explicitly reports otherwise. */
  default: 'deny' | 'allow';
  allowedHosts: string[];
};

export type SecretGrant = {
  id: string;
  name: string;
  exposure: 'environment' | 'command';
  expiresAt?: Date;
  allowedWorkers?: Array<'codex' | 'claude-code'>;
};

export type CreateWorkspaceInput = {
  orgId: string;
  projectId: string;
  purpose: WorkspacePurpose;
  source: WorkspaceSource;
  ttlMinutes: number;
  idleStopMinutes: number;
  network: NetworkPolicy;
  secrets: SecretGrant[];
  labels?: Record<string, string>;
};

export type WorkspaceHandle = {
  id: string;
  state: WorkspaceState;
};

export type WorkspaceExecRequest = {
  command: string;
  cwd?: string;
  timeoutSeconds: number;
  /** Grant ids, not secret values. The runtime resolves and injects them. */
  secretGrants?: string[];
};

export type WorkspaceExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type WorkspaceProcessRequest = Omit<WorkspaceExecRequest, 'timeoutSeconds'> & {
  name: string;
};

export type WorkspaceProcess = {
  id: string;
  name: string;
};

export type WorkspacePreview = {
  id: string;
  port: number;
  /** Selvedge-owned URL. Provider origins and credentials never reach the client. */
  url: string;
  expiresAt: Date;
};

export type BrowserEvidence = {
  screenshotArtifactIds: string[];
  consoleErrors: string[];
  failedRequests: Array<{ url: string; status: number | null }>;
};

export type WorkspaceCapabilities = {
  longRunningProcesses: boolean;
  authenticatedPreview: boolean;
  browserAutomation: boolean;
  enforceableNetworkPolicy: boolean;
  commandScopedSecrets: boolean;
};

export interface Workspace {
  readonly id: string;
  readonly capabilities: WorkspaceCapabilities;

  inspect(): Promise<WorkspaceHandle>;
  exec(request: WorkspaceExecRequest): Promise<WorkspaceExecResult>;
  startProcess(request: WorkspaceProcessRequest): Promise<WorkspaceProcess>;
  stopProcess(processId: string): Promise<void>;
  upload(path: string, data: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  exposePreview(input: { port: number; ttlMinutes: number }): Promise<WorkspacePreview>;
  captureBrowserEvidence(input: { previewId: string; path?: string }): Promise<BrowserEvidence>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export interface WorkspaceRuntime {
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  reconnectWorkspace(workspaceId: string): Promise<Workspace>;
  destroyWorkspace(workspaceId: string): Promise<void>;
}
