/**
 * The narrow OpenAI API boundary for Selvedge Development Workspaces.
 *
 * Kept on fetch rather than the SDK until the SDK version in this repository
 * exposes Containers + hosted shell. This module is deliberately unaware of
 * projects, threads and previews; it only owns the remote container lifecycle
 * and the model-mediated shell surface proven live on 2026-08-28.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
// OpenAI containers currently accept at most 20 minutes here. The anchor is
// last_active_at, so active work refreshes the idle window; Selvedge keeps its
// longer workspace/session TTL separately.
export const OPENAI_MAX_CONTAINER_IDLE_MINUTES = 20;

export type OpenAiMemoryLimit = '1g' | '4g' | '16g' | '64g';

export type OpenAiDomainSecret = {
  domain: string;
  name: string;
  value: string;
};

export type OpenAiNetworkPolicy =
  | { type: 'disabled' }
  | { type: 'allowlist'; allowed_domains: string[]; domain_secrets?: OpenAiDomainSecret[] };

export type OpenAiContainer = {
  id: string;
  object: string;
  status: string;
  name: string;
  created_at: number;
  last_active_at?: number;
  memory_limit?: OpenAiMemoryLimit;
  expires_after?: { anchor: 'last_active_at'; minutes: number };
  network_policy?: { type: 'disabled' | 'allowlist'; allowed_domains?: string[] };
};

export type OpenAiContainerFile = {
  id: string;
  path: string;
  bytes?: number;
  created_at?: number;
};

export type HostedShellResult = {
  responseId: string;
  status: string;
  stdout: string;
  stderr: string;
  commands: string[];
  text: string;
};

export class OpenAiWorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAiWorkspaceApiError';
  }
}

type FetchLike = typeof fetch;

export type OpenAiWorkspaceClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class OpenAiWorkspaceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;

  constructor(options: OpenAiWorkspaceClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error('an OpenAI API key is required');
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.doFetch = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.doFetch(joinUrl(this.baseUrl, path), { ...init, headers });
    if (!response.ok) {
      const body = record(await response.json().catch(() => null));
      const error = record(body?.error);
      throw new OpenAiWorkspaceApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : null,
        typeof error?.message === 'string' ? error.message : `OpenAI request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }

  createContainer(input: {
    name: string;
    expiresAfterMinutes: number;
    memoryLimit: OpenAiMemoryLimit;
    networkPolicy: OpenAiNetworkPolicy;
  }): Promise<OpenAiContainer> {
    const expiresAfterMinutes = Math.min(
      OPENAI_MAX_CONTAINER_IDLE_MINUTES,
      Math.max(1, Math.floor(input.expiresAfterMinutes)),
    );
    return this.request('/containers', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        expires_after: { anchor: 'last_active_at', minutes: expiresAfterMinutes },
        memory_limit: input.memoryLimit,
        network_policy: input.networkPolicy,
      }),
    });
  }

  retrieveContainer(containerId: string): Promise<OpenAiContainer> {
    return this.request(`/containers/${encodeURIComponent(containerId)}`);
  }

  async deleteContainer(containerId: string): Promise<void> {
    await this.request(`/containers/${encodeURIComponent(containerId)}`, { method: 'DELETE' });
  }

  /** Upload bytes into /mnt/data. The returned id can be used in later API calls. */
  async uploadFile(containerId: string, filename: string, data: Uint8Array): Promise<{ id: string; path: string }> {
    const form = new FormData();
    form.set('file', new Blob([data]), filename);
    return this.request(`/containers/${encodeURIComponent(containerId)}/files`, { method: 'POST', body: form });
  }

  async downloadFile(containerId: string, fileId: string): Promise<Uint8Array> {
    const response = await this.doFetch(
      joinUrl(this.baseUrl, `/containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}/content`),
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    if (!response.ok) throw new OpenAiWorkspaceApiError(response.status, null, `OpenAI file download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async listFiles(containerId: string): Promise<OpenAiContainerFile[]> {
    const result = await this.request<{ data?: OpenAiContainerFile[] }>(
      `/containers/${encodeURIComponent(containerId)}/files`,
    );
    return Array.isArray(result.data) ? result.data : [];
  }

  async deleteFile(containerId: string, fileId: string): Promise<void> {
    await this.request(
      `/containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Run a turn with OpenAI's hosted shell attached to a specific container.
   * Shell is model-mediated: callers must treat this as an agent operation,
   * never as a byte-for-byte replacement for a deterministic process API.
   */
  async runHostedShell(input: {
    containerId: string;
    model: string;
    prompt: string;
  }): Promise<HostedShellResult> {
    const body = await this.request<Record<string, unknown>>('/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: input.model,
        input: input.prompt,
        tools: [
          {
            type: 'shell',
            environment: { type: 'container_reference', container_id: input.containerId },
          },
        ],
        tool_choice: 'required',
      }),
    });

    const commands: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const text: string[] = [];
    const output = Array.isArray(body.output) ? body.output : [];
    for (const rawItem of output) {
      const item = record(rawItem);
      if (!item) continue;
      if (item.type === 'shell_call') {
        const action = record(item.action);
        if (Array.isArray(action?.commands)) {
          commands.push(...action.commands.filter((command): command is string => typeof command === 'string'));
        }
      } else if (item.type === 'shell_call_output' && Array.isArray(item.output)) {
        for (const rawChunk of item.output) {
          const chunk = record(rawChunk);
          if (!chunk) continue;
          if (string(chunk.stdout)) stdout.push(string(chunk.stdout));
          if (string(chunk.stderr)) stderr.push(string(chunk.stderr));
        }
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const rawContent of item.content) {
          const content = record(rawContent);
          if (content?.type === 'output_text' && string(content.text)) text.push(string(content.text));
        }
      }
    }

    return {
      responseId: string(body.id),
      status: string(body.status),
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      commands,
      text: text.join('\n'),
    };
  }
}
