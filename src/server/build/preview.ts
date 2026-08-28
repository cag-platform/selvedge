import type { Db } from '../db/client.js';
import { setBuild } from './store.js';
import { PREVIEW_TTL_MS } from './metering.js';
import { ensureSandbox, WORKDIR, PATH_PREFIX, type DevelopmentWorkspace, type SandboxConfig } from './sandbox.js';
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
const READY_TIMEOUT_SEC = 90;
const TOKEN_TTL_SECONDS = 3600;

export type PreviewStatus = {
  state: 'ready' | 'none' | 'error';
  url: string | null;
  /** Plain-English line for the owner when there is no URL to show. */
  message: string | null;
  /**
   * Something the owner could do that would plausibly fix this, offered at the
   * moment it is relevant rather than as a setting nobody reads. Only set when
   * the failure actually points at it.
   *
   * `env` exists because the diagnosis already NAMES the missing variable —
   * "The app needs STRIPE_SECRET_KEY to start" — and for a while it named it
   * and then told you to add it somewhere that did not exist. An instruction
   * with no destination is worse than no instruction.
   */
  offer?: 'database' | 'env';
};

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

async function exec(sandbox: DevelopmentWorkspace, command: string, timeoutSec: number): Promise<{ exitCode: number; result?: string }> {
  return sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
}

/** True when something is currently answering on :3000. */
export async function isAppServerUp(sandbox: DevelopmentWorkspace): Promise<boolean> {
  const probe = await exec(sandbox, `curl -s -o /dev/null -m 3 http://localhost:${APP_PORT} && echo UP || echo DOWN`, 15);
  return (probe.result ?? '').includes('UP');
}

/**
 * WHAT, IF ANYTHING, A BROWSER CAN OPEN HERE.
 *
 * This used to be one boolean — "does it have a dev script?" — and everything
 * that answered no was handed to a static file server pointed at the
 * repository root. For a web app without a dev script that is right. For
 * everything else it is a lie with a green light on it: an Xcode project
 * previewed as `Index of app/`, listing .gitignore and README.md and
 * RegionalPancreas.xcodeproj, reported as `ready`, under the heading "the app,
 * live in the workshop". A curl against a directory index returns 200, so
 * every check downstream agreed.
 *
 * Three answers now, and the third is the point: a repository can have nothing
 * in it that a browser can open, and saying so is the honest result rather than
 * a failure. It also names what it DID find, because "this is an iOS app" is
 * the whole explanation and leaving it out turns a clear answer into a shrug.
 */
export type PreviewShape =
  | { kind: 'dev' }
  | { kind: 'static'; dir: string }
  | { kind: 'none'; what: string | null };

/** Directories checked for an index.html, nearest-to-built first. */
const STATIC_DIRS = ['dist', 'build', 'out', 'public', '.'];

/**
 * What a repository with no web app in it appears to be, in the owner's words.
 * Ordered: the first match wins, so the most specific marker is the one named.
 */
const NOT_WEB: ReadonlyArray<readonly [glob: string, what: string]> = [
  ['*.xcodeproj', 'an Xcode project'],
  ['*.xcworkspace', 'an Xcode workspace'],
  ['Package.swift', 'a Swift package'],
  ['build.gradle', 'an Android or Gradle project'],
  ['build.gradle.kts', 'an Android or Gradle project'],
  ['Cargo.toml', 'a Rust crate'],
  ['go.mod', 'a Go module'],
  ['pyproject.toml', 'a Python package'],
  ['setup.py', 'a Python package'],
  ['Gemfile', 'a Ruby project'],
];

async function previewShape(sandbox: DevelopmentWorkspace): Promise<PreviewShape> {
  const devCheck = shellQuote('const s = require("./package.json").scripts || {}; process.exit(s.dev ? 0 : 1)');
  const staticChecks = STATIC_DIRS.map((d) => `[ -f ${d}/index.html ] && echo "STATIC:${d}" && exit 0`).join('; ');
  const whatChecks = NOT_WEB.map(([glob, what]) => `ls -d ${glob} >/dev/null 2>&1 && echo "WHAT:${what}" && exit 0`).join('; ');
  const probe = await exec(
    sandbox,
    `cd ${WORKDIR} || exit 0; if [ -f package.json ] && node -e ${devCheck}; then echo DEV; exit 0; fi; ${staticChecks}; ${whatChecks}; echo NONE`,
    60,
  );
  const out = probe.result ?? '';
  if (out.includes('DEV')) return { kind: 'dev' };
  const dir = /STATIC:(\S+)/.exec(out)?.[1];
  if (dir) return { kind: 'static', dir };
  return { kind: 'none', what: /WHAT:(.+)/.exec(out)?.[1]?.trim() ?? null };
}

/**
 * Said to the owner when the repository holds nothing a browser can open.
 * Not an apology and not an error — a preview is a window onto a running web
 * app, and some things you build are not one.
 */
export function nothingToPreviewLine(what: string | null): string {
  return what
    ? `There's nothing here I can show in a browser — this looks like ${what}. Previews only work for apps that serve a web page.`
    : "There's nothing here I can show in a browser. I couldn't find a dev server to start or an index.html to serve — previews only work for apps that serve a web page.";
}

/** Raised when there is no web app to start, as opposed to one that failed to. */
export class NothingToPreviewError extends Error {
  constructor(readonly what: string | null) {
    super('nothing to preview');
  }
}

async function killAppServer(sandbox: DevelopmentWorkspace): Promise<void> {
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
async function writeEnvFile(sandbox: DevelopmentWorkspace, contents: string | null): Promise<void> {
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
async function ensurePreviewDatabase(sandbox: DevelopmentWorkspace): Promise<boolean> {
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

async function startAppServer(sandbox: DevelopmentWorkspace, options: StartOptions): Promise<void> {
  await writeEnvFile(sandbox, options.envFile);

  // DATABASE_URL is set only when we actually brought one up, so an app that
  // reads it either finds a database there or finds nothing — never a URL
  // pointing at something that isn't listening, which fails later and worse.
  let databaseUrl: string | null = null;
  if (options.wantsDatabase) {
    databaseUrl = (await ensurePreviewDatabase(sandbox)) ? `postgresql://postgres@127.0.0.1:${PG_PORT}/app` : null;
  }

  // Decided BEFORE anything is started: a repository with nothing web-shaped
  // in it must not get a file server pointed at its own source tree.
  const shape = await previewShape(sandbox);
  if (shape.kind === 'none') throw new NothingToPreviewError(shape.what);
  // The environment is SOURCED, not interpolated: nothing from it reaches the
  // command string, so nothing from it reaches a log.
  const loadEnv = [
    options.envFile ? `set -a; . ${ENV_FILE}; set +a` : '',
    databaseUrl ? `export DATABASE_URL=${shellQuote(databaseUrl)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const prefix = loadEnv ? `${loadEnv}; ` : '';

  // The static branch serves a directory that was CHOSEN because it holds an
  // index.html, so what answers on :3000 is a page rather than a file listing.
  const inner =
    shape.kind === 'dev'
      ? `cd ${WORKDIR} && { [ -d node_modules ] || npm install; } && ${prefix}exec env PORT=${APP_PORT} HOST=0.0.0.0 npm run dev`
      : `cd ${WORKDIR} || exit 1; DIR=${shellQuote(shape.dir)}; (npx -y serve -l tcp://0.0.0.0:${APP_PORT} "$DIR" || python3 -m http.server ${APP_PORT} --bind 0.0.0.0 --directory "$DIR")`;
  const start = `${PATH_PREFIX} nohup bash -c ${shellQuote(inner)} >> ${LOG_FILE} 2>&1 < /dev/null & echo $! > ${PID_FILE}`;

  await exec(sandbox, start, 30);

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
  try {
    const sandbox = await ensureSandbox(db, orgId, projectId, cfg);

    if (!(await isAppServerUp(sandbox))) {
      const wanted = await getPreviewEnvSummary(db, orgId, projectId).catch(() => ({ keys: [], wantsDatabase: false, updatedAt: null }));
      await startAppServer(sandbox, {
        envFile: await previewEnvFile(db, orgId, projectId).catch(() => null),
        wantsDatabase: wanted.wantsDatabase,
      });
    }

    const preview = await sandbox.workspace.exposePreview({ port: APP_PORT, ttlMinutes: TOKEN_TTL_SECONDS / 60 });
    await setBuild(db, orgId, projectId, {
      previewUrl: preview.url,
      previewToken: null,
      previewTokenExpiresAt: preview.expiresAt,
      previewActiveUntil: new Date(Date.now() + PREVIEW_TTL_MS),
    });
    return { state: 'ready', url: preview.url, message: null };
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
    /**
     * NOT AN ERROR — an answer. Nothing failed and nothing is wrong; this
     * repository simply isn't a web app, which is a fact about it rather than
     * a problem with it. `none` is the state that says so, and it carries no
     * offer because there is nothing the owner could add that would make an
     * Xcode project open in a browser.
     */
    if (err instanceof NothingToPreviewError) {
      return { state: 'none', url: null, message: nothingToPreviewLine(err.what) };
    }
    if (err instanceof StartFailedError) {
      console.error(`preview failed to start for ${orgId}/${projectId}:`, err.log);
      const found = diagnoseStartFailure(err.log);
      return {
        state: 'error',
        url: null,
        message: previewFailureMessage(err.log),
        ...(found.kind === 'database'
          ? { offer: 'database' as const }
          : found.kind === 'missing_env'
            ? { offer: 'env' as const }
            : {}),
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
