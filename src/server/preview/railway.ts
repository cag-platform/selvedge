import type { Db } from '../db/client.js';
import { configurePreviewService, createService, deleteService, deployPreviewCommit, ensureServiceDomain, resolveHostProject, setServiceVariables } from '../connectors/railway/provision.js';
import { getDeployState, serviceExists, type RailwayTarget } from '../connectors/railway/client.js';
import { hostProjectOptions, resolveHostAccount } from '../build/hostAccount.js';
import type { CreatePreviewInput, PreviewHandle, PreviewRuntime } from './runtime.js';

type PreviewRecord = { orgId: string; handle: PreviewHandle; token: string; target: RailwayTarget; createdAt: Date };
type DurableId = { orgId: string; target: RailwayTarget; expiresAt: string; createdAt?: string; url: string };
function encode(value: DurableId): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(id: string): DurableId { return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as DurableId; }

/** First disposable preview adapter. Services live in the customer's Railway account and are explicitly deleted. */
export class RailwayPreviewRuntime implements PreviewRuntime {
  private readonly previews = new Map<string, PreviewRecord>();
  constructor(private readonly db: Db) {}

  async createPreview(input: CreatePreviewInput): Promise<PreviewHandle> {
    const account = await resolveHostAccount(this.db, input.orgId);
    if (!account || account.owner !== 'customer') throw new Error('Connect your Railway account before starting a hosted preview.');
    const host = await resolveHostProject(account.token, hostProjectOptions(account));
    const name = `preview-${input.projectId}-${Date.now().toString(36)}`.slice(0, 40);
    const serviceId = await createService(account.token, host.projectId, name, input.source.repository, {
      NODE_ENV: 'development', PORT: '3000', ...input.variables,
    }, input.source.ref);
    const target = { ...host, serviceId };
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    try {
      await configurePreviewService(account.token, target);
      await setServiceVariables(account.token, target, { NODE_ENV: 'development', PORT: '3000', ...input.variables });
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
    const noDeployIsStale = !deploy && record.createdAt.getTime() < Date.now() - 2 * 60_000;
    record.handle.state = deploy?.status === 'live'
      ? 'ready'
      : deploy?.status === 'failed' || noDeployIsStale || (!deploy && !(await serviceExists(record.token, record.target)))
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
