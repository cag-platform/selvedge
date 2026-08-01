import type { Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, PATH_PREFIX, type SandboxConfig } from './sandbox.js';

/**
 * The live preview — see the app running in the project's sandbox, in an
 * iframe, before anything ships. Ported from Toile's preview + app-server pair,
 * simplified to Selvedge's web-only scope (no Expo/Metro half).
 *
 * How it works, plainly: the sandbox runs the app on :3000 (a dev server when
 * the repo has one, a static file server otherwise), Daytona gives that port a
 * public URL, and a signed short-lived token rides the URL so only someone
 * Selvedge handed the link to can see it. Tokens are re-minted before expiry so
 * a served URL never lapses mid-look.
 *
 * COST NOTE: the preview lives in the same idle-auto-stop sandbox as the agent —
 * walking away stops the whole thing, compute included. Waking it re-starts the
 * app server transparently.
 */

const APP_PORT = 3000;
const LOG_FILE = '/tmp/selvedge-app.log';
const PID_FILE = '/tmp/selvedge-app.pid';
const SESSION = 'selvedge-app';
const READY_TIMEOUT_SEC = 90;
const TOKEN_TTL_SECONDS = 3600;
/** Re-mint before actual expiry so a just-served URL never lapses mid-load. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PREVIEW_TOKEN_PARAM = 'x-daytona-preview-token';

export type PreviewStatus = {
  state: 'ready' | 'none' | 'error';
  url: string | null;
  /** Plain-English line for the owner when there is no URL to show. */
  message: string | null;
};

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Append the signed token so the iframe can reach the preview port directly. */
export function withPreviewToken(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set(PREVIEW_TOKEN_PARAM, token);
  return url.toString();
}

/** Reuse a stored token while it has comfortable life left; else it needs a re-mint. */
export function tokenStillGood(token: string | null, expiresAt: Date | null, now: Date = new Date()): boolean {
  return Boolean(token && expiresAt && expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_MARGIN_MS);
}

async function exec(sandbox: Sandbox, command: string, timeoutSec: number): Promise<{ exitCode: number; result?: string }> {
  return sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
}

/** True when something is currently answering on :3000. */
export async function isAppServerUp(sandbox: Sandbox): Promise<boolean> {
  const probe = await exec(sandbox, `curl -s -o /dev/null -m 3 http://localhost:${APP_PORT} && echo UP || echo DOWN`, 15);
  return (probe.result ?? '').includes('UP');
}

/** True when /workspace/app has a package.json with a "dev" script. */
async function hasDevScript(sandbox: Sandbox): Promise<boolean> {
  const probe = await exec(
    sandbox,
    `cd ${WORKDIR} && if [ -f package.json ] && node -e ${shellQuote('const s = require("./package.json").scripts || {}; process.exit(s.dev ? 0 : 1)')}; then echo DEV; fi`,
    60,
  );
  return (probe.result ?? '').includes('DEV');
}

async function killAppServer(sandbox: Sandbox): Promise<void> {
  await exec(
    sandbox,
    [`kill -TERM $(cat ${PID_FILE} 2>/dev/null) 2>/dev/null`, `fuser -k -TERM ${APP_PORT}/tcp 2>/dev/null`, 'sleep 1', `fuser -k -KILL ${APP_PORT}/tcp 2>/dev/null`, 'true'].join('; '),
    30,
  ).catch(() => undefined);
}

/**
 * Start the app on :3000, detached: `npm run dev` when the repo has one
 * (PORT/HOST hints for servers that honour them), else a static file server
 * (dist/ preferred when built). Then wait, bounded, until it answers.
 */
async function startAppServer(sandbox: Sandbox): Promise<void> {
  const dev = await hasDevScript(sandbox);
  const inner = dev
    ? `cd ${WORKDIR} && { [ -d node_modules ] || npm install; } && exec env PORT=${APP_PORT} HOST=0.0.0.0 npm run dev`
    : `cd ${WORKDIR} || exit 1; DIR=.; if [ -f dist/index.html ]; then DIR=dist; fi; (npx -y serve -l tcp://0.0.0.0:${APP_PORT} "$DIR" || python3 -m http.server ${APP_PORT} --bind 0.0.0.0 --directory "$DIR")`;
  const start = `${PATH_PREFIX} nohup bash -c ${shellQuote(inner)} >> ${LOG_FILE} 2>&1 < /dev/null & echo $! > ${PID_FILE}`;

  await sandbox.process.createSession(SESSION).catch(() => undefined); // idempotent
  await sandbox.process.executeSessionCommand(SESSION, { command: start, runAsync: true });

  const check = await exec(
    sandbox,
    `for i in $(seq 1 ${READY_TIMEOUT_SEC}); do curl -s -o /dev/null -m 2 http://localhost:${APP_PORT} && exit 0; sleep 1; done; echo 'did not answer on :${APP_PORT}'; tail -c 1000 ${LOG_FILE} 2>/dev/null; exit 1`,
    READY_TIMEOUT_SEC + 15,
  );
  if (check.exitCode !== 0) throw new Error(`the app didn't start: ${check.result}`);
}

/** Flip a private sandbox public so its preview URL works in a plain iframe (SDK 0.187 has no public wrapper). */
async function makePublic(sandbox: Sandbox): Promise<void> {
  if (sandbox.public) return;
  const api = (sandbox as unknown as { sandboxApi?: { updatePublicStatus(id: string, isPublic: boolean): Promise<unknown> } }).sandboxApi;
  if (api) await api.updatePublicStatus(sandbox.id, true);
}

/** One in-flight ensure per (org, project): concurrent wakes must not race two app-server restarts. */
const inflight = new Map<string, Promise<PreviewStatus>>();

/**
 * Bring the preview up and return its URL: resume the sandbox if stopped,
 * (re)start the app server if it isn't answering, resolve the public URL for
 * :3000, and sign it with a fresh-enough token. Errors come back as a plain
 * message, never a throw — "can't show it right now" is a state, not a crash.
 */
export async function ensurePreview(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<PreviewStatus> {
  const key = `${orgId}/${projectId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = ensurePreviewUncached(db, orgId, projectId, cfg).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function ensurePreviewUncached(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<PreviewStatus> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.sandboxId) {
    return { state: 'none', url: null, message: 'Nothing is running yet — ask for a change first and the preview appears here.' };
  }

  try {
    const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
    await makePublic(sandbox);

    if (!(await isAppServerUp(sandbox))) await startAppServer(sandbox);

    const link = await sandbox.getPreviewLink(APP_PORT);
    let token = build.previewToken;
    if (!tokenStillGood(token, build.previewTokenExpiresAt)) {
      const signed = await sandbox.getSignedPreviewUrl(APP_PORT, TOKEN_TTL_SECONDS);
      token = signed.token;
      await setBuild(db, orgId, projectId, {
        previewUrl: link.url,
        previewToken: token,
        previewTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
      });
    } else {
      await setBuild(db, orgId, projectId, { previewUrl: link.url });
    }

    return { state: 'ready', url: withPreviewToken(link.url, token!), message: null };
  } catch (err) {
    return {
      state: 'error',
      url: null,
      message: `I couldn't bring the preview up: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
