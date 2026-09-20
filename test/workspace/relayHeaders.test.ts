import { describe, it, expect } from 'vitest';
import { allowlistPreviewResponseHeaders, previewSecurityHeaders } from '../../src/server/workspace/relay/protocol.js';

describe('workspace/relay response header isolation', () => {
  it('drops headers a previewed app tries to assert on the product origin', () => {
    const out = allowlistPreviewResponseHeaders({
      'content-type': 'text/html',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src *",
      'x-frame-options': 'ALLOWALL',
      'set-cookie': 'evil=1',
      'strict-transport-security': 'max-age=0',
    });
    expect(out).toEqual({ 'content-type': 'text/html', 'cache-control': 'no-store' });
    expect(out['access-control-allow-origin']).toBeUndefined();
    expect(out['content-security-policy']).toBeUndefined();
  });

  it('forces a sandbox CSP that opaques the preview origin', () => {
    const forced = previewSecurityHeaders();
    expect(forced['content-security-policy']).toMatch(/^sandbox /);
    // allow-same-origin is deliberately absent — that is what keeps it opaque.
    expect(forced['content-security-policy']).not.toContain('allow-same-origin');
    expect(forced['x-content-type-options']).toBe('nosniff');
  });
});
