import type { Db } from '../db/client.js';
import { createService, deleteService, ensureServiceDomain, resolveHostProject, setServiceVariables, waitForDeploy } from '../connectors/railway/provision.js';
import { getDeployState, type RailwayTarget } from '../connectors/railway/client.js';
import { hostProjectOptions, resolveHostAccount } from '../build/hostAccount.js';
import type { CreatePreviewInput, PreviewHandle, PreviewRuntime } from './runtime.js';

type PreviewRecord = { handle: PreviewHandle; token: string; target: RailwayTarget };

function encode(target: RailwayTarget): string {
  return `${target.projectId}/${target.environmentId}/${target.serviceId}`;
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
    const serviceId = await createService(account.token, host.projectId, name, input.source.repository, {
      NODE_ENV: 'development', PORT: '3000', ...input.variables,
    }, input.source.ref);
    const target = { ...host, serviceId };
    const id = encode(target);
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    try {
      await setServiceVariables(account.token, target, { NODE_ENV: 'development', PORT: '3000', ...input.variables });
      const url = await ensureServiceDomain(account.token, target);
      const handle: PreviewHandle = { id, state: 'building', url, expiresAt };
      this.previews.set(id, { handle, token: account.token, target });
      await waitForDeploy(account.token, target);
      handle.state = 'ready';
      return { ...handle };
    } catch (error) {
      await deleteService(account.token, serviceId).catch(() => undefined);
      throw error;
    }
  }

  async inspectPreview(id: string): Promise<PreviewHandle> {
    const record = this.previews.get(id);
    if (!record) throw new Error('preview is not available in this server process');
    if (record.handle.expiresAt.getTime() <= Date.now()) {
      await this.destroyPreview(id);
      return { ...record.handle, state: 'destroyed', url: null };
    }
    const deploy = await getDeployState(record.token, record.target);
    record.handle.state = deploy?.status === 'live' ? 'ready' : deploy?.status === 'failed' ? 'failed' : 'building';
    return { ...record.handle };
  }

  async destroyPreview(id: string): Promise<void> {
    const record = this.previews.get(id);
    if (!record) return;
    await deleteService(record.token, record.target.serviceId);
    record.handle.state = 'destroyed';
    record.handle.url = null;
    this.previews.delete(id);
  }
}
