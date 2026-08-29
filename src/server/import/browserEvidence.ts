import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright';

export type BrowserScreenshot = { id: string; bytes: Uint8Array; mime: 'image/png'; width: number; height: number };
export type MigrationBrowserEvidence = {
  screenshots: BrowserScreenshot[];
  consoleErrors: string[];
  failedRequests: Array<{ url: string; status: number | null; detail: string }>;
  routesChecked: string[];
  error: string | null;
};

const viewports = [
  { id: 'desktop', width: 1440, height: 1000 },
  { id: 'mobile', width: 390, height: 844 },
] as const;

function bounded(value: string, max = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
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
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: false });
      const page = await context.newPage();
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
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await assertUsablePage(page);
      routesChecked.push(new URL(page.url()).pathname);
      screenshots.push({ ...viewport, id: viewport.id, mime: 'image/png', bytes: await page.screenshot({ type: 'png', fullPage: true }) });
      await context.close();
    }
    return { screenshots, consoleErrors: [...new Set(consoleErrors)], failedRequests, routesChecked: [...new Set(routesChecked)], error: null };
  } catch (error) {
    return { screenshots, consoleErrors: [...new Set(consoleErrors)], failedRequests, routesChecked: [...new Set(routesChecked)], error: bounded(error instanceof Error ? error.message : String(error)) };
  } finally {
    await browser?.close();
  }
}

async function assertUsablePage(page: Page): Promise<void> {
  const title = await page.title();
  const text = await page.locator('body').innerText({ timeout: 5_000 });
  if (text.trim().length < 20) throw new Error('The rendered page did not contain enough visible content.');
  if (/application error|internal server error|cannot find module/i.test(`${title} ${text.slice(0, 2_000)}`)) throw new Error('The rendered page contains an application failure.');
}
