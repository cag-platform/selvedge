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
}
