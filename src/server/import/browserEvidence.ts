import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright';

export type BrowserScreenshot = { id: string; route: string; bytes: Uint8Array; mime: 'image/png'; width: number; height: number };
export type MigrationBrowserEvidence = {
  screenshots: BrowserScreenshot[];
  consoleErrors: string[];
  failedRequests: Array<{ url: string; status: number | null; detail: string }>;
  routesChecked: string[];
  error: string | null;
};

export type DiscoveredLink = { href: string; text: string; download: boolean };

const DESKTOP = { width: 1440, height: 1000 } as const;
const MOBILE = { width: 390, height: 844 } as const;
const MAX_ADDITIONAL_ROUTES = 3;
const UNSAFE_NAVIGATION = /(?:^|[\s/_-])(log\s*out|sign\s*out|delete|remove|destroy|unsubscribe|checkout|purchase|buy|pay|cancel)(?:$|[\s/_-])/i;
const PRIVATE_HOST = /^(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)$/i;

function bounded(value: string, max = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function relayPrefix(url: URL): string {
  return /^\/workspace-preview\/[^/]+/.exec(url.pathname)?.[0] ?? '';
}

function appRoute(url: URL, prefix: string): string {
  const route = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
  return `${route}${url.search}${url.hash}`;
}

/** Read-only, same-preview routes only. Root-relative app links are rebased through Selvedge's preview relay. */
export function safePreviewRoutes(links: DiscoveredLink[], currentUrl: string, limit = MAX_ADDITIONAL_ROUTES): Array<{ url: string; route: string }> {
  const current = new URL(currentUrl);
  const prefix = relayPrefix(current);
  const seen = new Set<string>([appRoute(current, prefix)]);
  const routes: Array<{ url: string; route: string }> = [];
  for (const link of links) {
    const href = link.href.trim();
    if (!href || link.download || /^(?:mailto:|tel:|javascript:|data:)/i.test(href) || UNSAFE_NAVIGATION.test(`${link.text} ${href}`)) continue;
    let target: URL;
    try {
      target = prefix && href.startsWith('/') ? new URL(`${prefix}${href}`, current.origin) : new URL(href, current);
    } catch {
      continue;
    }
    if (target.origin !== current.origin || target.username || target.password) continue;
    if (prefix && !target.pathname.startsWith(`${prefix}/`) && target.pathname !== prefix) continue;
    target.hash = target.hash && target.pathname === current.pathname ? target.hash : '';
    const route = appRoute(target, prefix);
    if (seen.has(route)) continue;
    seen.add(route);
    routes.push({ url: target.toString(), route });
    if (routes.length >= limit) break;
  }
  return routes;
}

export async function captureMigrationBrowserEvidence(url: string): Promise<MigrationBrowserEvidence> {
  let browser: Browser | null = null;
  const screenshots: BrowserScreenshot[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: MigrationBrowserEvidence['failedRequests'] = [];
  const routesChecked: string[] = [];
  const seenFailures = new Set<string>();
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, env: {}, args: ['--disable-extensions', '--disable-file-system'] });
    const desktop = await browser.newContext({ viewport: DESKTOP, serviceWorkers: 'block', acceptDownloads: false });
    const page = await desktop.newPage();
    await observePage(page, new URL(url).hostname, consoleErrors, failedRequests, seenFailures);
    await renderRoute(page, url);
    const prefix = relayPrefix(new URL(page.url()));
    routesChecked.push(appRoute(new URL(page.url()), prefix));
    screenshots.push(await screenshot(page, 'desktop-home', routesChecked[0]!, DESKTOP));

    const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 100).map((anchor) => ({ href: anchor.getAttribute('href') ?? '', text: anchor.textContent ?? '', download: anchor.hasAttribute('download') })));
    const discovered = safePreviewRoutes(links, page.url());
    for (const [index, route] of discovered.entries()) {
      await renderRoute(page, route.url);
      routesChecked.push(route.route);
      screenshots.push(await screenshot(page, `desktop-route-${index + 1}`, route.route, DESKTOP));
    }
    await desktop.close();

    const mobile = await browser.newContext({ viewport: MOBILE, serviceWorkers: 'block', acceptDownloads: false, isMobile: true, hasTouch: true });
    const mobilePage = await mobile.newPage();
    await observePage(mobilePage, new URL(url).hostname, consoleErrors, failedRequests, seenFailures);
    await renderRoute(mobilePage, url);
    screenshots.push(await screenshot(mobilePage, 'mobile-home', '/', MOBILE));
    await mobile.close();
    return { screenshots, consoleErrors: [...new Set(consoleErrors)], failedRequests, routesChecked: [...new Set(routesChecked)], error: null };
  } catch (error) {
    return { screenshots, consoleErrors: [...new Set(consoleErrors)], failedRequests, routesChecked: [...new Set(routesChecked)], error: bounded(error instanceof Error ? error.message : String(error)) };
  } finally {
    await browser?.close();
  }
}

async function observePage(page: Page, allowedHost: string, consoleErrors: string[], failedRequests: MigrationBrowserEvidence['failedRequests'], seenFailures: Set<string>): Promise<void> {
  await page.route('**/*', async (route) => {
    try {
      const target = new URL(route.request().url());
      if (target.protocol === 'file:' || (PRIVATE_HOST.test(target.hostname) && target.hostname !== allowedHost)) {
        await route.abort('blockedbyclient');
        return;
      }
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(bounded(message.text()));
  });
  page.on('requestfailed', (request: Request) => {
    const key = `${request.url()}|${request.failure()?.errorText ?? ''}`;
    if (!seenFailures.has(key) && failedRequests.length < 20) {
      seenFailures.add(key);
      failedRequests.push({ url: bounded(request.url()), status: null, detail: bounded(request.failure()?.errorText ?? 'Request failed') });
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 500 && failedRequests.length < 20) {
      const key = `${response.url()}|${response.status()}`;
      if (!seenFailures.has(key)) {
        seenFailures.add(key);
        failedRequests.push({ url: bounded(response.url()), status: response.status(), detail: `HTTP ${response.status()}` });
      }
    }
  });
}

async function renderRoute(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await assertUsablePage(page);
}

async function screenshot(page: Page, id: string, route: string, viewport: { width: number; height: number }): Promise<BrowserScreenshot> {
  return { ...viewport, id, route, mime: 'image/png', bytes: await page.screenshot({ type: 'png', fullPage: true }) };
}

async function assertUsablePage(page: Page): Promise<void> {
  const title = await page.title();
  const text = await page.locator('body').innerText({ timeout: 5_000 });
  if (text.trim().length < 20) throw new Error('The rendered page did not contain enough visible content.');
  if (/application error|internal server error|cannot find module/i.test(`${title} ${text.slice(0, 2_000)}`)) throw new Error('The rendered page contains an application failure.');
}
