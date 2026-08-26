export type BuskaMention = { name?: string; channel?: string; intent?: string; aiScore?: number; aiReason?: string; contentPreview?: string; postUrl?: string; link?: string; keyword?: string; publishedAt?: string; [key: string]: unknown };
type Fetcher = typeof fetch;

export class BuskaError extends Error { constructor(message: string, readonly status?: number) { super(message); this.name = 'BuskaError'; } }

export class BuskaClient {
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.buska.io/api/v1', private readonly fetcher: Fetcher = fetch, private readonly maxRetries = 2) {}
  private async call(path: string, init: RequestInit = {}) {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', ...init.headers } }); }
      catch (error) { if (attempt < this.maxRetries) continue; throw new BuskaError(error instanceof Error ? error.message : 'Buska request failed'); }
      if (response.ok) return response.json() as Promise<unknown>;
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after')); const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5_000, retryAfter * 1_000) : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay)); continue;
      }
      throw new BuskaError(`Buska returned ${response.status}`, response.status);
    }
  }
  async searchMentions(keyword: string, platform: string, limit = 50): Promise<{ results: BuskaMention[]; total: number }> {
    const body = await this.call('/mentions/search', { method: 'POST', body: JSON.stringify({ keyword, platform, limit }) }) as { results?: unknown; total?: unknown };
    return { results: Array.isArray(body.results) ? body.results as BuskaMention[] : [], total: typeof body.total === 'number' ? body.total : 0 };
  }
  async *signals(params: { platform?: string; since?: string; minScore?: number } = {}, pageSize = 50): AsyncGenerator<BuskaMention> {
    for (let offset = 0; ; offset += pageSize) {
      const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      if (params.platform) query.set('platform', params.platform); if (params.since) query.set('since', params.since); if (params.minScore !== undefined) query.set('minScore', String(params.minScore));
      const body = await this.call(`/signals?${query}`) as { signals?: unknown; total?: unknown };
      const page = Array.isArray(body.signals) ? body.signals as BuskaMention[] : [];
      for (const signal of page) yield signal;
      const total = typeof body.total === 'number' ? body.total : page.length; if (page.length < pageSize || offset + page.length >= total) break;
    }
  }
}
