import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/testDb.js';
import { getBuild } from '../../src/server/build/store.js';
import { verifyWorkshopPreview } from '../../src/server/build/preview.js';

describe('workshop preview evidence', () => {
  it('stores screenshots and the independent browser result on the project preview', async () => {
    const test = await createTestDb();
    const put = vi.fn().mockResolvedValue(undefined);
    try {
      const evidence = await verifyWorkshopPreview(test.db, 'org_1', 'project_1', 'https://preview.test', {
        store: { put, signedGet: vi.fn(), delete: vi.fn() },
        capture: async () => ({
          screenshots: [{ id: 'desktop-home', route: '/', bytes: new Uint8Array([1, 2]), mime: 'image/png', width: 1440, height: 1000 }],
          consoleErrors: [], failedRequests: [], routesChecked: ['/'],
          guidedJourney: { status: 'passed', name: 'No safe interaction needed', steps: [] }, error: null,
        }),
      });
      expect(evidence.status).toBe('passed');
      expect(evidence.screenshots[0]).toMatchObject({ route: '/', viewport: 'desktop' });
      expect(put).toHaveBeenCalledOnce();
      expect((await getBuild(test.db, 'org_1', 'project_1'))?.previewEvidence).toEqual(evidence);
    } finally { await test.close(); }
  });

  it('marks browser failures and replaces the previous screenshot evidence', async () => {
    const test = await createTestDb();
    const put = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = { put, signedGet: vi.fn(), delete: remove };
    try {
      const first = await verifyWorkshopPreview(test.db, 'org_1', 'project_1', 'https://preview.test', {
        store,
        capture: async () => ({
          screenshots: [{ id: 'desktop-home', route: '/', bytes: new Uint8Array([1]), mime: 'image/png', width: 1440, height: 1000 }],
          consoleErrors: [], failedRequests: [], routesChecked: ['/'],
          guidedJourney: { status: 'passed', name: 'No safe interaction needed', steps: [] }, error: null,
        }),
      });
      const second = await verifyWorkshopPreview(test.db, 'org_1', 'project_1', 'https://preview.test', {
        store,
        capture: async () => ({
          screenshots: [{ id: 'mobile-home', route: '/', bytes: new Uint8Array([2]), mime: 'image/png', width: 390, height: 844 }],
          consoleErrors: ['Uncaught Error'], failedRequests: ['GET /api/tasks — 500'], routesChecked: ['/'],
          guidedJourney: { status: 'failed', name: 'Browser check', steps: [] }, error: null,
        }),
      });
      expect(second.status).toBe('failed');
      expect(second.screenshots[0]?.viewport).toBe('mobile');
      expect(remove).toHaveBeenCalledWith(expect.stringContaining(first.screenshot_artifact_ids[0] ?? 'missing'));
      expect((await getBuild(test.db, 'org_1', 'project_1'))?.previewEvidence).toEqual(second);
    } finally { await test.close(); }
  });
});
