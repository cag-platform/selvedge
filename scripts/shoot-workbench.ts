import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * The workbench, photographed.
 *
 *   npx tsx scripts/shoot-workbench.ts [outfile.png]
 *
 * Starts the harness (scripts/workbench-shot — the real components against
 * fixed data, no server and no session), loads it in Chromium at a desktop
 * width, and writes a full-page screenshot. This is how the design notes'
 * third acceptance check is actually run rather than asserted: six projects,
 * thirty threads, and the question of whether it still reads calm.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const openSwitcher = process.argv.includes('--switcher');
const out = args[0] ?? path.resolve(here, '../workbench.png');
const URL_ = 'http://localhost:5199/harness.html';

async function main() {
  // Its own process group, so stopping it stops the whole tree — a vite left
  // holding the port makes the next run fail for a reason that has nothing to
  // do with the thing being checked.
  const vite = spawn('npx', ['vite', '--config', path.join(here, 'workbench-shot/vite.config.ts')], {
    cwd: path.resolve(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const stop = () => {
    try {
      if (vite.pid) process.kill(-vite.pid, 'SIGTERM');
    } catch {
      vite.kill('SIGTERM');
    }
  };
  process.on('exit', stop);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the harness did not start in time')), 30_000);
    vite.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('5199')) {
        clearTimeout(timer);
        resolve();
      }
    });
    vite.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  });

  // This environment ships its own Chromium (PLAYWRIGHT_BROWSERS_PATH) which
  // may not match the pinned Playwright's expected build, so point at it
  // directly when it's there rather than downloading a second copy.
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(existsSync(bundled) ? { executablePath: bundled } : {});
  const page = await browser.newPage({ viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2 });
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('requestfailed', (req) => problems.push(`${req.url()} — ${req.failure()?.errorText ?? 'failed'}`));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${res.url()} — HTTP ${res.status()}`);
  });

  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForSelector('nav[aria-label="Projects and threads"]');
  if (openSwitcher) {
    // The tantamount interaction, photographed: tap the chip, the list opens
    // in place, and every entry says what it costs before you pick it.
    await page.click('button[aria-haspopup="listbox"]');
    await page.waitForSelector('[role="listbox"]');
    // Let it arrive: --settle is 560ms, and a photograph taken mid-arrival is
    // a photograph of an animation, not of the design.
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: out });
  await browser.close();
  stop();

  console.log(`wrote ${out}`);
  if (problems.length) {
    console.error(`\n${problems.length} console/page error(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
