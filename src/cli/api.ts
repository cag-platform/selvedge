import type { SessionSummary } from '../shared/types/session.js';
import type { CompanionConfig } from './config.js';

/**
 * The companion's whole network surface: one authenticated origin, four calls,
 * no third parties. Every response is checked rather than assumed, and a
 * failure is returned rather than thrown — a daemon that dies because a laptop
 * lost wifi for a minute is a daemon nobody runs.
 */

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class CompanionApi {
  constructor(
    private config: CompanionConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    if (!this.config.token) return { ok: false, error: 'no key — run `selvedge login --token slv_…` first' };
    try {
      const res = await this.fetchImpl(`${this.config.api}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          ...init.headers,
        },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { ok: false, error: typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}` };
      }
      return { ok: true, value: body as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'the request did not go through' };
    }
  }

  hello() {
    return this.call<{ ok: boolean; projects: Array<{ id: string; name: string; repo: string | null }> }>('/api/companion/hello');
  }

  sendSession(summary: SessionSummary) {
    return this.call<{ recorded: boolean; project_id: string | null; note?: string }>('/api/companion/sessions', {
      method: 'POST',
      body: JSON.stringify(summary),
    });
  }

  /** One chunk of a history that has no export file — see importers/cursor.ts. */
  importConversations(batch: {
    vendor: string;
    conversations: Array<{
      sourceId: string;
      title: string;
      startedAt: string | null;
      messages: Array<{ role: 'owner' | 'agent'; content: string; at: string | null }>;
    }>;
    unreadable: Array<{ ref: string; reason: string }>;
  }) {
    return this.call<{ filed: number; already_had: number; unreadable: number; summary: string }>('/api/companion/import/conversations', {
      method: 'POST',
      body: JSON.stringify(batch),
    });
  }

  projects() {
    return this.call<{ projects: Array<{ id: string; name: string; repo: string | null }> }>('/api/companion/context');
  }

  context(projectId: string) {
    return this.call<{ project: { id: string; name: string }; text: string }>(`/api/companion/context/${encodeURIComponent(projectId)}`);
  }

  changes(projectId: string, days: number) {
    return this.call<{ days: number; changes: string[] }>(`/api/companion/context/${encodeURIComponent(projectId)}/changes?days=${days}`);
  }

  issues(projectId: string) {
    return this.call<{ issues: string[] }>(`/api/companion/context/${encodeURIComponent(projectId)}/issues`);
  }

  connectAppleRuntime(input: { name: string; xcodeVersion: string; macosVersion: string; capabilities: { xcode: true; iosSimulator: true } }) {
    return this.call<{ connected: true; host_id: string; heartbeat_seconds: number }>('/api/companion/runtime/apple/connect', {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  heartbeatAppleRuntime() {
    return this.call<{ connected: true }>('/api/companion/runtime/apple/heartbeat', { method: 'POST' });
  }

  disconnectAppleRuntime() {
    return this.call<{ disconnected: true }>('/api/companion/runtime/apple', { method: 'DELETE' });
  }

  claimAppleRuntimeJob() {
    return this.call<{ job: null | { id: string; projectId?: string | null; kind: 'toolchain_check' | 'chat_turn'; request: Record<string, unknown> } }>('/api/companion/runtime/apple/jobs/claim', { method: 'POST' });
  }

  finishAppleRuntimeJob(jobId: string, result: { ok: boolean; xcodeVersion?: string; simulatorName?: string; macosVersion?: string; detail?: string; narrative?: string; changedPaths?: string[]; buildOutput?: string }) {
    return this.call<{ recorded: true }>(`/api/companion/runtime/apple/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: 'POST', body: JSON.stringify(result),
    });
  }

  async downloadAppleRuntimeSource(jobId: string): Promise<ApiResult<{ bytes: Uint8Array; layout: 'github' | 'workspace' | 'empty' }>> {
    if (!this.config.token) return { ok: false, error: 'no key' };
    try {
      const res = await this.fetchImpl(`${this.config.api}/api/companion/runtime/apple/jobs/${encodeURIComponent(jobId)}/source`, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: body.error ?? `${res.status} ${res.statusText}` };
      }
      const layout = (res.headers.get('x-selvedge-archive-layout') ?? 'empty') as 'github' | 'workspace' | 'empty';
      return { ok: true, value: { bytes: res.status === 204 ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()), layout } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'source download failed' };
    }
  }

  async uploadAppleRuntimeArchive(jobId: string, bytes: Uint8Array): Promise<ApiResult<{ stored: true; bytes: number }>> {
    if (!this.config.token) return { ok: false, error: 'no key' };
    try {
      const res = await this.fetchImpl(`${this.config.api}/api/companion/runtime/apple/jobs/${encodeURIComponent(jobId)}/archive`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes),
      });
      const body = await res.json().catch(() => ({})) as { stored?: true; bytes?: number; error?: string };
      return res.ok ? { ok: true, value: body as { stored: true; bytes: number } } : { ok: false, error: body.error ?? `${res.status} ${res.statusText}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'workspace upload failed' };
    }
  }
}
