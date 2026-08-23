import type { Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, PATH_PREFIX, type SandboxConfig } from './sandbox.js';
import { isAllowedPreviewUrl } from '../../shared/preview.js';
import { previewSlugFor } from '../web/previewProxy.js';
import { diagnoseStartFailure, previewFailureMessage } from './previewDiagnosis.js';
import { previewEnvFile, getPreviewEnvSummary } from './previewEnv.js';

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
/**
 * The preview's environment, DELIBERATELY OUTSIDE THE CHECKOUT.
 *
 * /tmp, never /workspace/app. A .env written into the repository is one
 * `git add -A` away from a customer's secrets landing in their own public
 * history — the same reason this codebase refuses to write a CLAUDE.md into a
 * customer repo, with worse consequences.
 */
const ENV_FILE = '/tmp/selvedge-preview.env';
const PG_DATA = '/tmp/selvedge-pg';
const PG_PORT = 5432;
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
  /**
   * Something the owner could turn on that would plausibly fix this, offered at
   * the moment it is relevant rather than as a setting nobody reads. Only set
   * when the failure actually points at it.
   */
  offer?: 'database';
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
/**
 * Put the project's preview environment into the sandbox, outside the repo.
 *
 * Uploaded as a file rather than passed on the command line, because a command
 * string ends up in a log and a failed step's output is quoted back to the
 * owner verbatim. The start command sources it; the secrets never appear in
 * anything that gets printed.
 */
async function writeEnvFile(sandbox: Sandbox, contents: string | null): Promise<void> {
  if (!contents) {
    await exec(sandbox, `rm -f ${ENV_FILE}`, 15).catch(() => undefined);
    return;
  }
  await sandbox.fs.uploadFile(Buffer.from(`${contents}\n`, 'utf-8'), ENV_FILE);
  // Readable by nobody else in the box. Belt for a sandbox that holds one
  // customer's project, and free.
  await exec(sandbox, `chmod 600 ${ENV_FILE}`, 15).catch(() => undefined);
}

/**
 * A throwaway Postgres, on request, for an imported app that expects one.
 *
 * Empty, sandbox-only, and gone when the sandbox is. It never touches a real
 * database of the owner's — the point is to let a `migrate` step succeed
 * against something, not to reproduce production.
 *
 * Idempotent and bounded: already-running is success, and a box where it cannot
 * be installed returns false rather than throwing, because a preview without a
 * database is still worth trying.
 */
async function ensurePreviewDatabase(sandbox: Sandbox): Promise<boolean> {
  const up = await exec(sandbox, `pg_isready -h 127.0.0.1 -p ${PG_PORT} >/dev/null 2>&1 && echo UP || echo DOWN`, 20).catch(() => null);
  if ((up?.result ?? '').includes('UP')) return true;

  const script = [
    'set -e',
    'command -v pg_ctl >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1 || (sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql)',
    'PGBIN="$(dirname "$(ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | head -1)")" || true',
    '[ -n "$PGBIN" ] || PGBIN="$(dirname "$(command -v initdb)")"',
    `[ -d ${PG_DATA} ] || ("$PGBIN/initdb" -D ${PG_DATA} -U postgres --auth=trust >/dev/null)`,
    `"$PGBIN/pg_ctl" -D ${PG_DATA} -o "-p ${PG_PORT} -k /tmp" -l /tmp/selvedge-pg.log start >/dev/null 2>&1 || true`,
    `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${PG_PORT} >/dev/null 2>&1 && break; sleep 1; done`,
    `"$PGBIN/createdb" -h 127.0.0.1 -p ${PG_PORT} -U postgres app >/dev/null 2>&1 || true`,
    `pg_isready -h 127.0.0.1 -p ${PG_PORT} >/dev/null 2>&1`,
  ].join('; ');

  const made = await exec(sandbox, `bash -lc ${shellQuote(script)} && echo READY || echo FAILED`, 300).catch(() => null);
  return (made?.result ?? '').includes('READY');
}

export type StartOptions = { envFile: string | null; wantsDatabase: boolean };

async function startAppServer(sandbox: Sandbox, options: StartOptions): Promise<void> {
  await writeEnvFile(sandbox, options.envFile);

  // DATABASE_URL is set only when we actually brought one up, so an app that
  // reads it either finds a database there or finds nothing — never a URL
  // pointing at something that isn't listening, which fails later and worse.
  let databaseUrl: string | null = null;
  if (options.wantsDatabase) {
    databaseUrl = (await ensurePreviewDatabase(sandbox)) ? `postgresql://postgres@127.0.0.1:${PG_PORT}/app` : null;
  }

  const dev = await hasDevScript(sandbox);
  // The environment is SOURCED, not interpolated: nothing from it reaches the
  // command string, so nothing from it reaches a log.
  const loadEnv = [
    options.envFile ? `set -a; . ${ENV_FILE}; set +a` : '',
    databaseUrl ? `export DATABASE_URL=${shellQuote(databaseUrl)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const prefix = loadEnv ? `${loadEnv}; ` : '';

  const inner = dev
    ? `cd ${WORKDIR} && { [ -d node_modules ] || npm install; } && ${prefix}exec env PORT=${APP_PORT} HOST=0.0.0.0 npm run dev`
    : `cd ${WORKDIR} || exit 1; DIR=.; if [ -f dist/index.html ]; then DIR=dist; fi; (npx -y serve -l tcp://0.0.0.0:${APP_PORT} "$DIR" || python3 -m http.server ${APP_PORT} --bind 0.0.0.0 --directory "$DIR")`;
  const start = `${PATH_PREFIX} nohup bash -c ${shellQuote(inner)} >> ${LOG_FILE} 2>&1 < /dev/null & echo $! > ${PID_FILE}`;

  await sandbox.process.createSession(SESSION).catch(() => undefined); // idempotent
  await sandbox.process.executeSessionCommand(SESSION, { command: start, runAsync: true });

  const check = await exec(
    sandbox,
    `for i in $(seq 1 ${READY_TIMEOUT_SEC}); do curl -s -o /dev/null -m 2 http://localhost:${APP_PORT} && exit 0; sleep 1; done; echo 'did not answer on :${APP_PORT}'; tail -c 2000 ${LOG_FILE} 2>/dev/null; exit 1`,
    READY_TIMEOUT_SEC + 15,
  );
  if (check.exitCode !== 0) throw new StartFailedError(check.result ?? '');
}

/**
 * Carries the LOG, not a sentence.
 *
 * The message a person reads is composed once, at the surface, by
 * previewDiagnosis — so the raw output travels as data rather than being
 * concatenated into an error string that then gets printed at somebody. That
 * concatenation is precisely how a Node stack trace ended up in the panel.
 */
export class StartFailedError extends Error {
  constructor(readonly log: string) {
    super('the app did not start');
    this.name = 'StartFailedError';
  }
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
  /**
   * NO SANDBOX YET IS NOT A REASON TO REFUSE.
   *
   * This used to return early with "ask for a change first" whenever the
   * project had never had a turn — which meant a repository imported from
   * GitHub could not be previewed at all until somebody asked an agent to
   * change something. Nothing about a preview needs the code to have been
   * written here; it needs a checkout, and `ensureSandbox` makes one.
   *
   * Safe to do now in a way it was not before: previews are checked against
   * the plan's build minutes at the route, metered per second from the moment
   * the sandbox exists, and stopped by the sweep within a minute of going
   * quiet. A preview that starts a sandbox is a bounded, visible cost rather
   * than an open tap.
   */
  const build = await getBuild(db, orgId, projectId);

  try {
    const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
    await makePublic(sandbox);

    if (!(await isAppServerUp(sandbox))) {
      const wanted = await getPreviewEnvSummary(db, orgId, projectId).catch(() => ({ keys: [], wantsDatabase: false, updatedAt: null }));
      await startAppServer(sandbox, {
        envFile: await previewEnvFile(db, orgId, projectId).catch(() => null),
        wantsDatabase: wanted.wantsDatabase,
      });
    }

    const link = await sandbox.getPreviewLink(APP_PORT);
    // The SSRF guard's enforcement point: a URL outside the Daytona allowlist
    // is never stored, so the proxy can never be steered at an arbitrary host.
    if (!isAllowedPreviewUrl(link.url)) {
      return { state: 'error', url: null, message: 'The preview URL did not look like a Daytona preview, so I refused it.' };
    }
    // Re-read: the sandbox may have been created a moment ago, and the row
    // read before that has no slug or token on it.
    const current = (await getBuild(db, orgId, projectId)) ?? build;
    const slug = current?.previewSlug ?? previewSlugFor(orgId, projectId);
    let token = current?.previewToken ?? null;
    if (!tokenStillGood(token, current?.previewTokenExpiresAt ?? null)) {
      const signed = await sandbox.getSignedPreviewUrl(APP_PORT, TOKEN_TTL_SECONDS);
      token = signed.token;
      await setBuild(db, orgId, projectId, {
        previewUrl: link.url,
        previewSlug: slug,
        previewToken: token,
        previewTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
      });
    } else {
      await setBuild(db, orgId, projectId, { previewUrl: link.url, previewSlug: slug });
    }

    // With PREVIEW_DOMAIN configured, the iframe gets the proxied subdomain URL
    // (the proxy injects the skip-warning header — no Daytona interstitial).
    // Without it, the signed direct Daytona URL, warning included.
    const domain = process.env.PREVIEW_DOMAIN?.trim();
    const url = domain ? `https://${slug}.${domain}/` : withPreviewToken(link.url, token!);
    return { state: 'ready', url, message: null };
  } catch (err) {
    /**
     * THE STACK TRACE STOPS HERE.
     *
     * This used to concatenate `err.message` — which for a failed start was a
     * thousand characters of tail'd app log — straight into the panel. The
     * whole content of that trace was usually one sentence long, and the
     * sentence was the part nobody got.
     *
     * The raw output is not lost: it goes to the server log, and the failure
     * that produced it is still the failure. What changes is what a person
     * reads first.
     */
    if (err instanceof StartFailedError) {
      console.error(`preview failed to start for ${orgId}/${projectId}:`, err.log);
      const found = diagnoseStartFailure(err.log);
      return {
        state: 'error',
        url: null,
        message: previewFailureMessage(err.log),
        ...(found.kind === 'database' ? { offer: 'database' as const } : {}),
      };
    }
    console.error(`preview failed for ${orgId}/${projectId}:`, err);
    return {
      state: 'error',
      url: null,
      message: "I couldn't bring the preview up. The reason is in the record — nothing was changed.",
    };
  }
}
