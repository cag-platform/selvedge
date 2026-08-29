import { describe, expect, it } from 'vitest';
import { safePreviewRoutes } from '../../src/server/import/browserEvidence.js';

describe('safe migration preview route discovery', () => {
  const current = 'https://tryselvedge.com/workspace-preview/preview_123/';

  it('rebases app routes through the signed relay and keeps exploration bounded', () => {
    const routes = safePreviewRoutes([
      { href: '/dashboard', text: 'Dashboard', download: false },
      { href: 'settings', text: 'Settings', download: false },
      { href: '/reports', text: 'Reports', download: false },
      { href: '/fourth', text: 'Fourth', download: false },
    ], current);
    expect(routes.map((route) => route.route)).toEqual(['/dashboard', '/settings', '/reports']);
    expect(routes[0]?.url).toBe('https://tryselvedge.com/workspace-preview/preview_123/dashboard');
  });

  it('refuses external, download, duplicate, and mutation-like links', () => {
    const routes = safePreviewRoutes([
      { href: 'https://example.com', text: 'External', download: false },
      { href: '/export.csv', text: 'Export', download: true },
      { href: '/logout', text: 'Log out', download: false },
      { href: '/account/delete', text: 'Delete account', download: false },
      { href: '/', text: 'Home', download: false },
      { href: '/about', text: 'About', download: false },
      { href: '/about', text: 'About again', download: false },
    ], current);
    expect(routes.map((route) => route.route)).toEqual(['/about']);
  });

  it('can inspect client-side hash routes without leaving the preview', () => {
    const routes = safePreviewRoutes([{ href: '#settings', text: 'Settings', download: false }], current);
    expect(routes).toEqual([{ url: `${current}#settings`, route: '/#settings' }]);
  });
});
