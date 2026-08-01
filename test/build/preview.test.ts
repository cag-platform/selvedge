import { describe, it, expect } from 'vitest';
import { withPreviewToken, tokenStillGood } from '../../src/server/build/preview.js';

describe('withPreviewToken — the signed URL handed to the iframe', () => {
  it('appends the token as the daytona preview param', () => {
    const url = withPreviewToken('https://3000-abc.proxy.daytona.work/', 'tok_1');
    expect(url).toBe('https://3000-abc.proxy.daytona.work/?x-daytona-preview-token=tok_1');
  });

  it('replaces an existing token rather than stacking a second one', () => {
    const url = withPreviewToken('https://3000-abc.proxy.daytona.work/?x-daytona-preview-token=old', 'new');
    expect(url).toContain('x-daytona-preview-token=new');
    expect(url).not.toContain('old');
  });
});

describe('tokenStillGood — re-mint before expiry, never serve a lapsing token', () => {
  const now = new Date('2026-08-01T12:00:00Z');

  it('a token with comfortable life left is reused', () => {
    expect(tokenStillGood('tok', new Date('2026-08-01T12:30:00Z'), now)).toBe(true);
  });

  it('a token inside the 5-minute refresh margin is NOT reused — a just-served URL must never lapse mid-load', () => {
    expect(tokenStillGood('tok', new Date('2026-08-01T12:04:00Z'), now)).toBe(false);
  });

  it('missing token or expiry is never good', () => {
    expect(tokenStillGood(null, new Date('2026-08-01T13:00:00Z'), now)).toBe(false);
    expect(tokenStillGood('tok', null, now)).toBe(false);
  });
});
