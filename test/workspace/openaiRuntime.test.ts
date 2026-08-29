import { describe, expect, it, vi } from 'vitest';
import type { OpenAiWorkspaceClient } from '../../src/server/workspace/openai/client.js';
import { OpenAiWorkspaceRuntime } from '../../src/server/workspace/openai/runtime.js';
import { PreviewRelaySessions } from '../../src/server/workspace/relay/session.js';

function fixture() {
  const client = {
    createContainer: vi.fn().mockResolvedValue({ id: 'cntr_1', status: 'running' }),
    retrieveContainer: vi.fn().mockResolvedValue({ id: 'cntr_1', status: 'running' }),
    deleteContainer: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn()
      .mockResolvedValueOnce({ id: 'file_connector', path: '/mnt/data/selvedge-preview-connector.mjs' })
      .mockResolvedValueOnce({ id: 'file_config', path: '/mnt/data/relay.json' }),
    runHostedShell: vi.fn().mockResolvedValue({
      responseId: 'resp_1', status: 'completed', stdout: `cloned\n__SELVEDGE_EXIT__=0\n`, stderr: '', commands: [], text: '',
    }),
    listFiles: vi.fn(), downloadFile: vi.fn(), deleteFile: vi.fn(),
  } as unknown as OpenAiWorkspaceClient;
  const relay = new PreviewRelaySessions('this-test-secret-is-long-enough-for-hmac', 'https://preview.selvedge.test');
  const runtime = new OpenAiWorkspaceRuntime({
    client, relay, model: 'gpt-5.4',
    resolveSecretGrant: async () => 'secret',
    captureBrowserEvidence: async () => ({ screenshotArtifactIds: ['artifact_1'], consoleErrors: [], failedRequests: [] }),
  });
  return { client, runtime };
}

describe('OpenAI Workspace Runtime', () => {
  it('reports an expired container as recoverable instead of returning the cached ready state', async () => {
    const { client, runtime } = fixture();
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    });
    vi.mocked(client.retrieveContainer).mockResolvedValueOnce({ id: 'cntr_1', status: 'expired' } as never);

    await expect(workspace.inspect()).rejects.toMatchObject({ status: 409, code: 'container_expired' });
  });

  it('rejects an expired container while reconnecting after a Selvedge process restart', async () => {
    const { client, runtime } = fixture();
    vi.mocked(client.retrieveContainer).mockResolvedValueOnce({ id: 'cntr_old', status: 'expired' } as never);

    await expect(runtime.reconnectWorkspaceWithContext('cntr_old', {
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    })).rejects.toMatchObject({ status: 409, code: 'container_expired' });
  });

  it('creates a restricted temporary container and checks out the customer source', async () => {
    const { client, runtime } = fixture();
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: ['registry.npmjs.org'] }, secrets: [],
    });

    expect(workspace.id).toBe('cntr_1');
    expect(client.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      expiresAfterMinutes: 60,
      networkPolicy: { type: 'allowlist', allowed_domains: ['registry.npmjs.org', 'preview.selvedge.test', 'github.com'] },
    }));
    expect(client.runHostedShell).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('git clone --single-branch'),
    }));
  });

  it('installs the outbound connector without putting its capability in model input', async () => {
    const { client, runtime } = fixture();
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'git@github.com:customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    });
    const preview = await workspace.exposePreview({ port: 3000, ttlMinutes: 10 });

    expect(preview.url).toContain('/workspace-preview/');
    const configBytes = vi.mocked(client.uploadFile).mock.calls[1]?.[2];
    const config = JSON.parse(new TextDecoder().decode(configBytes));
    const prompts = vi.mocked(client.runHostedShell).mock.calls.map(([input]) => input.prompt).join('\n');
    expect(config.token).toBeTruthy();
    expect(prompts).not.toContain(config.token);
    expect(prompts).not.toContain('?preview_token=');
  });

  it('hydrates a server-fetched repository snapshot without exposing GitHub credentials to the container network', async () => {
    const { client, runtime } = fixture();
    vi.mocked(client.uploadFile).mockResolvedValueOnce({ id: 'source_1', path: '/mnt/data/source.tar.gz' });
    await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'migration',
      source: {
        kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main', credentialGrant: 'github_1',
        snapshot: { filename: 'source.tar.gz', data: new Uint8Array([1, 2, 3]) },
      },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] },
      secrets: [{ id: 'github_1', name: 'GITHUB_TOKEN', exposure: 'command' }],
    });

    expect(client.uploadFile).toHaveBeenCalledWith('cntr_1', 'source.tar.gz', new Uint8Array([1, 2, 3]));
    const prompts = vi.mocked(client.runHostedShell).mock.calls.map(([input]) => input.prompt).join('\n');
    expect(prompts).toContain('tar -xzf');
    expect(prompts).not.toContain('x-access-token');
  });
});
