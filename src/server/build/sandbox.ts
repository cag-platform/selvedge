import { Daytona, DaytonaNotFoundError, type Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { getBuild, setBuild, clearSandbox } from './store.js';
import { SANDBOX_AUTOSTOP_MINUTES, closeSandboxRun, openSandboxRun, type EndReason } from './metering.js';

/**
 * The persistent per-project sandbox — the workshop's engine. Ported from
 * Toile's sandbox lifecycle, org-scoped to Selvedge and built around one hard
 * rule the founder set: watch the cost.
 *
 * COST CONTROL. A running sandbox bills compute; a stopped one bills only cheap
 * storage. So every sandbox is created with Daytona's native idle auto-stop —
 * after SANDBOX_IDLE_MINUTES with no activity it stops itself, and the next use
 * transparently resumes it (a few seconds). Nothing is left running by accident,
 * and the owner never pays for an idle workshop. One sandbox per project, reused
 * across every edit — never one-per-change.
 *
 * The workdir setup uses sudo (verified working on the Daytona base image, which
 * already ships Node 25 and the Claude Code CLI, so no Node install is needed).
 */

export const WORKDIR = '/workspace/app';
export const PATH_PREFIX = 'export PATH="$HOME/.npm-global/bin:$PATH" &&';
/**
 * Idle minutes before a sandbox stops itself.
 *
 * Down from fifteen, and no longer the main guard: `build/metering.ts` runs a
 * sweep every minute that knows whether a turn is actually in flight, and stops
 * a sandbox within a minute of its work finishing. Daytona's own timer is the
 * backstop for when this server isn't running to sweep, which is why it is not
 * set as tight as the sweep — a native auto-stop firing between two commands of
 * one turn would destroy work to save pennies.
 */
export const SANDBOX_IDLE_MINUTES = SANDBOX_AUTOSTOP_MINUTES;

const DEAD_STATES = new Set(['destroyed', 'destroying', 'error', 'build_failed']);

let client: Daytona | null = null;
function daytona(): Daytona {
  if (!client) client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  return client;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * What it takes to have a working copy of a repo on a machine. Note what is
 * absent: any model credential. Which agent runs, and on whose account, is
 * decided per turn (build/builderAuth.ts) and never travels with the sandbox.
 */
export type SandboxConfig = {
  githubToken: string;
  repoFullName: string;
  /** The repo's OWN default branch, looked up per build — never assumed. */
  branch: string;
  /** True when the repo has no commits yet, so `branch` doesn't exist to clone. */
  emptyRepo?: boolean;
  /** Resume this checkout, but never try to recreate it without repo access. */
  reuseOnly?: boolean;
};

/**
 * The clone, as a string a test can hold. Two shapes: a repo with history is
 * cloned at its default branch by name; a repo with NO commits has no branch
 * to ask for — `--branch` fails against it whatever the name — so it is
 * cloned bare and its default branch is created in the sandbox, making a
 * brand-new repo a place a builder can start rather than a cryptic failure.
 */
export function cloneCommand(cfg: SandboxConfig): string {
  const url = `https://github.com/${cfg.repoFullName}.git`;
  if (cfg.emptyRepo) {
    return `git clone ${url} ${WORKDIR} && cd ${WORKDIR} && git checkout -b ${shellQuote(cfg.branch)}`;
  }
  return `git clone --branch ${shellQuote(cfg.branch)} ${url} ${WORKDIR}`;
}

/**
 * `env` is how the GitHub token reaches a command, and the only way it should.
 * Daytona passes it to the process directly, so it never appears in the command
 * string — which matters because a failed step's output is quoted back to the
 * owner verbatim, and a token in an error message is a token in a log.
 */
async function run(
  sandbox: Sandbox,
  label: string,
  command: string,
  timeoutSec: number,
  env?: Record<string, string>,
): Promise<string> {
  const res = await sandbox.process.executeCommand(command, undefined, env, timeoutSec);
  if (res.exitCode !== 0) throw new Error(`Sandbox step "${label}" failed (exit ${res.exitCode}): ${res.result}`);
  return res.result ?? '';
}

/** Create the workdir (sudo where /workspace isn't user-writable) and clone the repo. */
async function prepare(sandbox: Sandbox, cfg: SandboxConfig): Promise<void> {
  await run(
    sandbox,
    'workdir',
    `mkdir -p ${WORKDIR} 2>/dev/null || (sudo -n mkdir -p ${WORKDIR} && sudo -n chown -R "$(id -un)" ${WORKDIR})`,
    60,
  );
  // The base image ships Node 25 + Claude Code; only install Node if it's absent
  // or older than 20 (never downgrade a newer one).
  const node = await sandbox.process.executeCommand('node --version || echo MISSING', undefined, undefined, 30);
  const major = /v(\d+)\./.exec(node.result ?? '')?.[1];
  if (!major || Number(major) < 20) {
    await run(sandbox, 'node20', 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs', 600);
  }
  // Ensure the Claude Code CLI is present (no-op if the image already has it).
  await sandbox.process
    .executeCommand(`${PATH_PREFIX} claude --version || npm install -g --prefix "$HOME/.npm-global" @anthropic-ai/claude-code`, undefined, undefined, 300)
    .catch(() => undefined);

  const helper = '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f';
  await run(
    sandbox,
    'git config',
    `git config --global user.name "Selvedge" && git config --global user.email "selvedge@users.noreply.github.com" && git config --global credential.helper ${shellQuote(helper)}`,
    30,
  );
  await run(sandbox, 'clone', cloneCommand(cfg), 600, { GITHUB_TOKEN: cfg.githubToken });
}

async function create(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<Sandbox> {
  const sandbox = await daytona().create(
    {
      labels: { 'selvedge/org': orgId, 'selvedge/project': projectId },
      public: false,
      autoStopInterval: SANDBOX_IDLE_MINUTES, // the sandbox-cost guard
      // NO CREDENTIALS ARE BAKED IN HERE. A sandbox outlives any secret by
      // days: a token pinned at creation is an hour's worth of working and then
      // a puzzling failure. Every secret travels with the command that needs
      // it, fresh per request — the GitHub installation token, and now the
      // builder's own model credential too.
      //
      // The Claude Code token used to sit on this line, directly beneath a
      // comment explaining why the GitHub token must not. It was also the
      // DEPLOYMENT's token rather than the org's, which meant a sandbox
      // belonging to one customer was started holding the credentials everyone
      // else's builds ran on. See build/builderAuth.ts.
    },
    { timeout: 300 },
  );
  // Metered from the moment it exists, not from the moment it is useful. A
  // clone that takes four minutes and then fails cost four minutes of a running
  // machine, and a meter that only counted successful sandboxes would report
  // the cheapest possible version of a bad afternoon.
  await openSandboxRun(db, orgId, projectId, sandbox.id).catch((err) =>
    console.error(`could not open a metering segment for ${orgId}/${projectId} (${sandbox.id}):`, err),
  );
  try {
    await prepare(sandbox, cfg);
  } catch (err) {
    await sandbox.delete(60).catch(() => undefined);
    await closeSandboxRun(db, sandbox.id, 'failed').catch(() => null);
    throw err;
  }
  await setBuild(db, orgId, projectId, { sandboxId: sandbox.id, repoFullName: cfg.repoFullName, branch: cfg.branch });
  return sandbox;
}

/**
 * Return a started, ready sandbox for the project:
 *   - none yet        → create + prepare + persist
 *   - stopped/archived → resume (start)
 *   - deleted upstream → clear and recreate transparently
 * The idle auto-stop means "resume" is the common path, and it's cheap.
 *
 * THE ONE PLACE A SANDBOX CAN START, WHICH IS WHY METERING BEGINS HERE.
 *
 * Every path that could bring one up — a build turn, a plan turn, a preview, a
 * ship — comes through this function. Opening the metering segment here rather
 * than in each of those callers is what makes "never let a sandbox exist that
 * we aren't metering" a property of the code rather than a rule someone has to
 * remember on the day they add the fifth caller.
 *
 * `openSandboxRun` is idempotent per sandbox: this runs on every turn and
 * usually finds one already started, so it refreshes the segment's proof of
 * life rather than opening a second one.
 */
export async function ensureSandbox(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<Sandbox> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.sandboxId) return create(db, orgId, projectId, cfg);

  let sandbox: Sandbox;
  try {
    sandbox = await daytona().get(build.sandboxId);
  } catch (err) {
    if (err instanceof DaytonaNotFoundError) {
      // Deleted upstream while we thought it was running. Whatever we had open
      // is closed at the last moment we knew it was alive rather than left to
      // the sweep, so the replacement below cannot be the second open segment
      // for this project.
      await closeSandboxRun(db, build.sandboxId, 'reaper').catch(() => null);
      await clearSandbox(db, orgId, projectId);
      if (cfg.reuseOnly) throw new Error('The old workshop copy has expired. Connect the repository to create a fresh preview.');
      return create(db, orgId, projectId, cfg);
    }
    throw err;
  }

  if (sandbox.state && DEAD_STATES.has(sandbox.state)) {
    // Gone at Daytona, so whatever segment we still had open ended when we last
    // knew it was alive. Closed before the replacement opens its own, because
    // two open segments for one project is how the same seconds get counted
    // twice.
    await closeSandboxRun(db, build.sandboxId, 'failed').catch(() => null);
    await clearSandbox(db, orgId, projectId);
    if (cfg.reuseOnly) throw new Error('The old workshop copy has expired. Connect the repository to create a fresh preview.');
    return create(db, orgId, projectId, cfg);
  }
  if (sandbox.state !== 'started') await sandbox.start(300);
  await openSandboxRun(db, orgId, projectId, sandbox.id).catch((err) => {
    // A meter that fails must not take the turn down with it. It is loud
    // instead, and the daily reconciliation catches the sandbox either way.
    console.error(`could not open a metering segment for ${orgId}/${projectId} (${sandbox.id}):`, err);
  });
  return sandbox;
}

/** Stop a project's sandbox now (owner left / done). Idle auto-stop is the backstop; this is the explicit one. */
export async function stopSandbox(db: Db, orgId: string, projectId: string, reason: EndReason = 'user_stop'): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.sandboxId) return;
  await daytona()
    .get(build.sandboxId)
    .then((s) => (s.state === 'started' ? s.stop() : undefined))
    .catch(() => undefined);
  // Metered on the way out, and metered even if the stop above failed: the
  // seconds were spent whether or not Daytona took our word for it.
  await closeSandboxRun(db, build.sandboxId, reason).catch((err) =>
    console.error(`could not close the metering segment for ${orgId}/${projectId}:`, err),
  );
}

/** Permanently delete a project's sandbox and clear its build state. */
export async function deleteSandbox(db: Db, orgId: string, projectId: string): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (build?.sandboxId) {
    await daytona()
      .get(build.sandboxId)
      .then((s) => s.delete(60))
      .catch(() => undefined);
    await closeSandboxRun(db, build.sandboxId, 'user_stop').catch(() => null);
  }
  await clearSandbox(db, orgId, projectId);
}
