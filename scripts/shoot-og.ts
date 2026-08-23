import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * The share card, photographed.
 *
 *   npx tsx scripts/shoot-og.ts [outfile.png]
 *
 * Writes `src/client/public/og.png` at 1200×630 — what unfurls when somebody
 * pastes tryselvedge.com into Slack, X, or a message.
 *
 * It is a PHOTOGRAPH OF THE REAL COMPONENT, not a mock: scripts/og-shot/card.tsx
 * mounts the landing page's own `SampleThread`. Re-run it whenever that changes,
 * and the card cannot drift into showing a product that no longer exists.
 *
 * Reduced motion is forced on, which collapses `--settle-duration` to 0ms
 * (tokens.css) — otherwise the messages are caught mid-arrival and the card is a
 * picture of a half-faded conversation.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.resolve(here, '../src/client/public/og.png');

async function main() {
  // Its own process group, so stopping it stops the whole tree — a vite left
  // holding the port makes the next run fail for an unrelated reason.
  const vite = spawn('npx', ['vite', '--config', path.join(here, 'og-shot/vite.config.ts')], {
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
    const timer = setTimeout(() => reject(new Error('the card harness did not start in time')), 30_000);
    vite.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('5198')) {
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
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });

  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });

  await page.goto('http://localhost:5198/card.html', { waitUntil: 'networkidle' });
  const card = await page.waitForSelector('#card');
  // Fonts settle after paint; a card shot mid-swap ships in the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  mkdirSync(path.dirname(out), { recursive: true });
  await card.screenshot({ path: out });
  await browser.close();
  stop();

  if (problems.length > 0) {
    console.error('The card rendered, but the page complained:');
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Wrote ${out} — 1200×630, from the landing page's own sample thread.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
