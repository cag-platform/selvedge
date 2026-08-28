import { describe, expect, it } from 'vitest';
import { OpenAiWorkspaceApiError, OpenAiWorkspaceClient } from '../../src/server/workspace/openai/client.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAiWorkspaceClient', () => {
  it('creates an expiring, network-restricted container without leaking provider details upward', async () => {
    let request: { url: string; init?: RequestInit } | null = null;
    const client = new OpenAiWorkspaceClient({
      apiKey: 'secret-test-key',
      fetch: (async (url, init) => {
        request = { url: String(url), init };
        return response({ id: 'cntr_1', object: 'container', status: 'running', name: 'selvedge', created_at: 1 });
      }) as typeof fetch,
    });

    const created = await client.createContainer({
      name: 'selvedge',
      expiresAfterMinutes: 20,
      memoryLimit: '4g',
      networkPolicy: {
        type: 'allowlist',
        allowed_domains: ['relay.selvedge.example'],
        domain_secrets: [{ domain: 'relay.selvedge.example', name: 'SELVEDGE_RELAY_TOKEN', value: 'relay-secret' }],
      },
    });

    expect(created.id).toBe('cntr_1');
    expect(request).not.toBeNull();
    const captured = request as unknown as { url: string; init: RequestInit };
    expect(captured.url).toBe('https://api.openai.com/v1/containers');
    expect(JSON.parse(String(captured.init.body))).toMatchObject({
      expires_after: { anchor: 'last_active_at', minutes: 20 },
      memory_limit: '4g',
      network_policy: { type: 'allowlist', allowed_domains: ['relay.selvedge.example'] },
    });
    expect(new Headers(captured.init.headers).get('Authorization')).toBe('Bearer secret-test-key');
  });

  it('attaches hosted shell to the chosen container and returns structured evidence', async () => {
    const client = new OpenAiWorkspaceClient({
      apiKey: 'key',
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.tools[0].environment).toEqual({ type: 'container_reference', container_id: 'cntr_1' });
        return response({
          id: 'resp_1',
          status: 'completed',
          output: [
            { type: 'shell_call', action: { commands: ['node --version'] } },
            { type: 'shell_call_output', output: [{ stdout: 'v22\n', stderr: '' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Node is ready.' }] },
          ],
        });
      }) as typeof fetch,
    });

    await expect(client.runHostedShell({ containerId: 'cntr_1', model: 'gpt-5.4', prompt: 'Check Node.' })).resolves.toEqual({
      responseId: 'resp_1',
      status: 'completed',
      commands: ['node --version'],
      stdout: 'v22\n',
      stderr: '',
      text: 'Node is ready.',
    });
  });

  it('returns bounded API errors and never includes the API key', async () => {
    const client = new OpenAiWorkspaceClient({
      apiKey: 'do-not-leak',
      fetch: (async () => response({ error: { code: 'bad_request', message: 'invalid container' } }, 400)) as typeof fetch,
    });

    const error = await client.retrieveContainer('bad').catch((caught) => caught);
    expect(error).toBeInstanceOf(OpenAiWorkspaceApiError);
    expect(error.message).toBe('invalid container');
    expect(error.message).not.toContain('do-not-leak');
  });
});
