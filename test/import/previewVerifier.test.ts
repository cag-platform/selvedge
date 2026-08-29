import { describe, expect, it } from 'vitest';
import { attachBrowserEvidence, verifyMigrationPreview } from '../../src/server/import/previewVerifier.js';

describe('migration preview verifier', () => {
  it('follows the signed-preview cookie handoff and verifies a meaningful document', async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get('cookie');
      calls.push({ url, cookie });
      if (calls.length === 1) return new Response('', { status: 302, headers: { location: '/workspace-preview/p1/', 'set-cookie': 'selvedge_preview=token; Path=/;' } });
      return new Response('<!doctype html><html><head><title>My app</title></head><body><main>A complete and meaningful migrated application document with enough content to inspect safely.</main></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    };
    const result = await verifyMigrationPreview('https://selvedge.example/workspace-preview/p1/?preview_token=x', new Date('2026-08-29T00:00:00Z'), fetcher as typeof fetch);
    expect(result.status).toBe('passed');
    expect(result.independent_from_migration_agent).toBe(true);
    expect(calls[1]?.cookie).toBe('selvedge_preview=token');
  });

  it('fails an error document and remains honest about missing browser evidence', async () => {
    const fetcher = async () => new Response('<html><head><title>Application Error</title></head><body>Internal server error '.repeat(10), { status: 500, headers: { 'content-type': 'text/html' } });
    const result = await verifyMigrationPreview('https://preview.example', new Date(), fetcher as typeof fetch);
    expect(result.status).toBe('failed');
    expect(result.screenshot_artifact_ids).toEqual([]);
    expect(result.limitations.join(' ')).toContain('Screenshot');
  });

  it('requires stored responsive browser evidence before verification passes', async () => {
    const fetcher = async () => new Response('<html><body>A meaningful application page with enough visible content for deterministic verification.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const base = await verifyMigrationPreview('https://preview.example', new Date('2026-08-29T00:00:00Z'), fetcher as typeof fetch);
    const result = attachBrowserEvidence(base, {
      screenshots: [],
      consoleErrors: [],
      failedRequests: [],
      routesChecked: ['/'],
      error: null,
    }, ['desktop-id', 'mobile-id'], new Date('2026-08-29T00:01:00Z'));
    expect(result.status).toBe('passed');
    expect(result.screenshot_artifact_ids).toEqual(['desktop-id', 'mobile-id']);
    expect(result.routes_checked).toEqual(['/']);
    expect(result.limitations.join(' ')).toContain('form submissions');
  });

  it('fails when the real browser reports a runtime error', async () => {
    const fetcher = async () => new Response('<html><body>A meaningful application page with enough visible content for deterministic verification.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const base = await verifyMigrationPreview('https://preview.example', new Date(), fetcher as typeof fetch);
    const result = attachBrowserEvidence(base, {
      screenshots: [],
      consoleErrors: ['Uncaught Error: startup failed'],
      failedRequests: [],
      routesChecked: ['/'],
      error: null,
    }, ['desktop-id', 'mobile-id']);
    expect(result.status).toBe('failed');
    expect(result.console_errors).toEqual(['Uncaught Error: startup failed']);
  });
});
