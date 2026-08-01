import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPreviewProxy, previewSlugFor, hostSlug } from '../../src/server/web/previewProxy.js';
import { isAllowedPreviewUrl } from '../../src/shared/preview.js';
import { setBuild } from '../../src/server/build/store.js';

describe('previewSlugFor — unique per (org, project), readable, DNS-safe', () => {
  it('derives a stable slug from the project with an org-scoped hash', () => {
    const slug = previewSlugFor('org_1', 'loom');
    expect(slug).toMatch(/^loom-[0-9a-f]{8}$/);
    expect(previewSlugFor('org_1', 'loom')).toBe(slug); // stable
  });

  it('the same project name under two orgs never collides', () => {
    expect(previewSlugFor('org_1', 'loom')).not.toBe(previewSlugFor('org_2', 'loom'));
  });

  it('sanitizes awkward project ids into DNS labels', () => {
    expect(previewSlugFor('o', 'My Shop_v2!')).toMatch(/^my-shop-v2-[0-9a-f]{8}$/);
  });
});

describe('hostSlug — only our preview subdomains match', () => {
  const domain = 'preview.tryselvedge.com';
  it('extracts the slug from a preview host', () => {
    expect(hostSlug('loom-abc12345.preview.tryselvedge.com', domain)).toBe('loom-abc12345');
    expect(hostSlug('loom-abc12345.preview.tryselvedge.com:443', domain)).toBe('loom-abc12345');
  });
  it('ignores the main domain, foreign hosts, nested labels, and unset config', () => {
    expect(hostSlug('tryselvedge.com', domain)).toBeNull();
    expect(hostSlug('evil.com', domain)).toBeNull();
    expect(hostSlug('a.b.preview.tryselvedge.com', domain)).toBeNull();
    expect(hostSlug('x.preview.tryselvedge.com', undefined)).toBeNull();
  });
});

describe('isAllowedPreviewUrl — the SSRF allowlist', () => {
  it('accepts real Daytona preview hosts, https only', () => {
    expect(isAllowedPreviewUrl('https://3000-abc123.daytonaproxy01.net/')).toBe(true);
    expect(isAllowedPreviewUrl('https://3000-abc.proxy.daytona.work/')).toBe(true);
  });
  it('refuses everything else', () => {
    expect(isAllowedPreviewUrl('https://evil.com/')).toBe(false);
    expect(isAllowedPreviewUrl('http://3000-abc.daytonaproxy01.net/')).toBe(false); // not https
    expect(isAllowedPreviewUrl('https://user:pw@3000-abc.daytonaproxy01.net/')).toBe(false); // credentials
    expect(isAllowedPreviewUrl('not a url')).toBe(false);
  });
});

describe('targetForSlug — only ever the stored, allowlisted origin', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('resolves a known slug to its Daytona origin', async () => {
    await setBuild(db, 'org_1', 'loom', { previewSlug: 'loom-abc12345', previewUrl: 'https://3000-xyz.daytonaproxy01.net/some/path' });
    const proxy = createPreviewProxy(db);
    expect(await proxy.targetForSlug('loom-abc12345')).toBe('https://3000-xyz.daytonaproxy01.net');
  });

  it('an unknown slug, or a stored URL outside the allowlist, resolves to nothing', async () => {
    await setBuild(db, 'org_1', 'bad', { previewSlug: 'bad-slug', previewUrl: 'https://evil.com/' });
    const proxy = createPreviewProxy(db);
    expect(await proxy.targetForSlug('nope')).toBeNull();
    expect(await proxy.targetForSlug('bad-slug')).toBeNull(); // SSRF-safe even if a bad URL slipped into the DB
  });
});
