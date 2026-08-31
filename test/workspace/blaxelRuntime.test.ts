import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewRelaySessions } from '../../src/server/workspace/relay/session.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@blaxel/core', () => ({
  SandboxInstance: {
    create: sdk.create,
    get: sdk.get,
    delete: sdk.remove,
  },
}));

import { BlaxelWorkspaceRuntime } from '../../src/server/workspace/blaxel/runtime.js';

function fixture() {
  const process = {
    exec: vi.fn().mockResolvedValue({
      pid: 'pid-1', name: 'command', status: 'completed', exitCode: 0,
      stdout: 'ok\n', stderr: '', logs: 'ok\n', command: '', workingDir: '/workspace/project',
      startedAt: '', completedAt: '',
    }),
    wait: vi.fn(), get: vi.fn(), kill: vi.fn(), stop: vi.fn(), list: vi.fn().mockResolvedValue([]),
  };
  const fs = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    readBinary: vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('.exit')) return new Blob(['0']);
      if (path.endsWith('.stdout')) return new Blob(['ok\n']);
      if (path.endsWith('.stderr')) return new Blob(['']);
      return new Blob([new Uint8Array([1, 2, 3])]);
    }),
  };
  const sandbox = {
    metadata: { name: 'selvedge-project-123' },
    status: 'DEPLOYED', spec: { enabled: true }, process, fs,
    wait: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  sdk.create.mockResolvedValue(sandbox);
  sdk.get.mockResolvedValue(sandbox);
  const runtime = new BlaxelWorkspaceRuntime({
    relay: new PreviewRelaySessions('this-test-secret-is-long-enough-for-hmac', 'https://preview.selvedge.test'),
    region: 'us-pdx-1',
    resolveSecretGrant: async () => 'resolved-secret',
    captureBrowserEvidence: async () => ({ screenshotArtifactIds: [], consoleErrors: [], failedRequests: [] }),
  });
  return { runtime, sandbox, process, fs };
}

beforeEach(() => vi.clearAllMocks());

describe('Blaxel Workspace Runtime', () => {
  it('creates a restricted microVM and checks out the project without changing the Selvedge contract', async () => {
    const { runtime, process } = fixture();
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'blaxel-launchboard-clean-proof-with-a-long-name', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main', credentialGrant: 'github_1' },
      ttlMinutes: 180, idleStopMinutes: 15,
      network: { default: 'deny', allowedHosts: ['registry.npmjs.org'] },
      secrets: [{ id: 'github_1', name: 'GITHUB_TOKEN', exposure: 'command' }],
    });

    expect(workspace.id).toBe('selvedge-project-123');
    const createInput = sdk.create.mock.calls[0]?.[0] as { name: string };
    expect(createInput.name.length).toBeLessThanOrEqual(49);
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      image: 'blaxel/ts-app:latest', memory: 4096, region: 'us-pdx-1',
      lifecycle: { expirationPolicies: [
        { type: 'ttl-max-age', value: '180m', action: 'delete' },
      ] },
      network: { proxy: { allowedDomains: ['registry.npmjs.org', 'preview.selvedge.test', 'github.com'], routing: [] } },
    }));
    expect(process.exec).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('clone --single-branch'),
      env: { GITHUB_TOKEN: 'resolved-secret' },
    }));
  });

  it('uses direct process and filesystem APIs rather than a model turn', async () => {
    const { runtime, process, fs } = fixture();
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    });

    await expect(workspace.exec({ command: 'npm test', cwd: '/workspace/project', timeoutSeconds: 300 }))
      .resolves.toMatchObject({ exitCode: 0, stdout: 'ok\n' });
    await workspace.upload('/workspace/project/input.bin', new Uint8Array([7, 8]));
    await expect(workspace.download('/workspace/project/input.bin')).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(process.exec).toHaveBeenLastCalledWith(expect.objectContaining({
      command: expect.stringContaining('npm test'), workingDir: '/workspace/project', waitForCompletion: false,
    }));
    expect(fs.writeBinary).toHaveBeenCalledWith('/workspace/project/input.bin', new Uint8Array([7, 8]));
  });

  it('retries transient filesystem failures while a sandbox wakes', async () => {
    const { runtime, fs } = fixture();
    fs.writeBinary.mockRejectedValueOnce(new Error('Failed to write binary: 502')).mockResolvedValueOnce(undefined);
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    });

    await expect(workspace.upload('/workspace/project/input.bin', new Uint8Array([7, 8]))).resolves.toBeUndefined();
    expect(fs.writeBinary).toHaveBeenCalledTimes(2);
  });

  it('uses filesystem results when Blaxel process status remains running', async () => {
    const { runtime, process } = fixture();
    process.exec.mockResolvedValueOnce({
      pid: 'clone', name: 'clone', status: 'completed', exitCode: 0, stdout: '', stderr: '',
      logs: '', command: '', workingDir: '/workspace/project', startedAt: '', completedAt: '',
    }).mockResolvedValueOnce({
      pid: 'pid-2', name: 'command', status: 'running', exitCode: 0, stdout: '', stderr: '',
      logs: '', command: '', workingDir: '/workspace/project', startedAt: '', completedAt: '',
    });
    const workspace = await runtime.createWorkspace({
      orgId: 'org_1', projectId: 'project_1', purpose: 'development',
      source: { kind: 'git', repository: 'https://github.com/customer/app.git', ref: 'main' },
      ttlMinutes: 60, idleStopMinutes: 15, network: { default: 'deny', allowedHosts: [] }, secrets: [],
    });

    await expect(workspace.exec({ command: 'echo done', timeoutSeconds: 5 })).resolves.toEqual({
      exitCode: 0, stdout: 'ok\n', stderr: '',
    });
    const wrapped = process.exec.mock.calls.at(-1)?.[0]?.command as string;
    expect(wrapped).toMatch(/^\{ echo done; code=\$\?/);
    expect(wrapped).not.toContain('process.get');
    expect(process.get).not.toHaveBeenCalled();
  });
});
