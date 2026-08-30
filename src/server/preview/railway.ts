import type { Db } from '../db/client.js';
import { configurePreviewService, connectServiceRepository, createEmptyService, deleteService, deployPreviewCommit, ensureServiceDomain, resolveHostProject, setServiceVariables } from '../connectors/railway/provision.js';
import { getDeployState, serviceExists, type RailwayTarget } from '../connectors/railway/client.js';
import { hostProjectOptions, resolveHostAccount } from '../build/hostAccount.js';
import type { CreatePreviewInput, PreviewHandle, PreviewRuntime } from './runtime.js';

type PreviewRecord = { orgId: string; handle: PreviewHandle; token: string; target: RailwayTarget; createdAt: Date };
type DurableId = { orgId: string; target: RailwayTarget; expiresAt: string; createdAt?: string; url: string };
function encode(value: DurableId): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(id: string): DurableId { return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as DurableId; }

// A development checkpoint can legitimately contain package-manifest changes
// before its lockfile has been refreshed. Production should stay frozen; this
// disposable preview must install the checkpoint the agent actually produced.
// Railpack runs this override in a shell, so keep all common JS managers local
// to the temporary service instead of teaching Selvedge a project-specific
// package-manager preference.
export const PREVIEW_INSTALL_COMMAND = "if [ -f pnpm-lock.yaml ]; then pnpm install --no-frozen-lockfile --prefer-offline; elif [ -f yarn.lock ]; then yarn install --no-immutable; else npm install; fi";

function previewVariables(projectId: string, input: Record<string, string>): Record<string, string> {
  return { NODE_ENV: 'development', PORT: '3000', ...input, RAILPACK_INSTALL_CMD: PREVIEW_INSTALL_COMMAND, SELVEDGE_PROJECT_ID: projectId };
}

/** First disposable preview adapter. Services live in the customer's Railway account and are explicitly deleted. */
export class RailwayPreviewRuntime implements PreviewRuntime {
  private readonly previews = new Map<string, PreviewRecord>();
  constructor(private readonly db: Db) {}

  async createPreview(input: CreatePreviewInput): Promise<PreviewHandle> {
    const account = await resolveHostAccount(this.db, input.orgId);
    if (!account || account.owner !== 'customer') throw new Error('Connect your Railway account before starting a hosted preview.');
    const host = await resolveHostProject(account.token, hostProjectOptions(account));
    const name = `preview-${input.projectId}-${Date.now().toString(36)}`.slice(0, 40);
    const variables = previewVariables(input.projectId, input.variables);
    const serviceId = await createEmptyService(account.token, host.projectId, name, variables);
    const target = { ...host, serviceId };
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    try {
      await configurePreviewService(account.token, target);
      await setServiceVariables(account.token, target, variables);
      await connectServiceRepository(account.token, serviceId, input.source.repository, input.source.ref);
      await deployPreviewCommit(account.token, target, input.source.commitSha);
      const url = await ensureServiceDomain(account.token, target);
      const id = encode({ orgId: input.orgId, target, expiresAt: expiresAt.toISOString(), createdAt: createdAt.toISOString(), url });
      const handle: PreviewHandle = { id, state: 'building', url, expiresAt };
      this.previews.set(id, { orgId: input.orgId, handle, token: account.token, target, createdAt });
      return { ...handle };
    } catch (error) {
      await deleteService(account.token, serviceId).catch(() => undefined);
      throw error;
    }
  }

  async inspectPreview(id: string): Promise<PreviewHandle> {
    let record = this.previews.get(id);
    if (!record) {
      const saved = decode(id);
      const account = await resolveHostAccount(this.db, saved.orgId);
      if (!account || account.owner !== 'customer') throw new Error('the Railway connection for this preview is unavailable');
      const handle: PreviewHandle = { id, state: 'building', url: saved.url, expiresAt: new Date(saved.expiresAt) };
      const createdAt = saved.createdAt ? new Date(saved.createdAt) : new Date(handle.expiresAt.getTime() - 10 * 60_000);
      record = { orgId: saved.orgId, handle, token: account.token, target: saved.target, createdAt };
      this.previews.set(id, record);
    }
    if (record.handle.expiresAt.getTime() <= Date.now()) {
      await this.destroyPreview(id);
      return { ...record.handle, state: 'destroyed', url: null };
    }
    const deploy = await getDeployState(record.token, record.target);
    const nonLiveIsStale = deploy?.status !== 'live' && record.createdAt.getTime() < Date.now() - 5 * 60_000;
    const exists = await serviceExists(record.token, record.target);
    record.handle.state = deploy?.status === 'live'
      && exists
      ? 'ready'
      : deploy?.status === 'failed' || nonLiveIsStale || !exists
        ? 'failed'
        : 'building';
    return { ...record.handle };
  }

  async destroyPreview(id: string): Promise<void> {
    let record = this.previews.get(id);
    if (!record) {
      const saved = decode(id);
      const account = await resolveHostAccount(this.db, saved.orgId);
      if (!account || account.owner !== 'customer') return;
      const expiresAt = new Date(saved.expiresAt);
      record = { orgId: saved.orgId, token: account.token, target: saved.target, createdAt: saved.createdAt ? new Date(saved.createdAt) : new Date(expiresAt.getTime() - 10 * 60_000), handle: { id, state: 'building', url: saved.url, expiresAt } };
    }
    await deleteService(record.token, record.target.serviceId);
    record.handle.state = 'destroyed';
    record.handle.url = null;
    this.previews.delete(id);
  }
}
