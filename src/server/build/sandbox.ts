import { Daytona, DaytonaNotFoundError, type Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { getBuild, setBuild, clearSandbox } from './store.js';

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
/** Idle minutes before a sandbox stops itself. The core sandbox-cost guard. */
export const SANDBOX_IDLE_MINUTES = 15;

const DEAD_STATES = new Set(['destroyed', 'destroying', 'error', 'build_failed']);

let client: Daytona | null = null;
function daytona(): Daytona {
  if (!client) client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  return client;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export type SandboxConfig = {
  claudeCodeOauthToken: string;
  githubToken: string;
  repoFullName: string;
  branch: string;
};

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
  await run(
    sandbox,
    'clone',
    `git clone --branch ${shellQuote(cfg.branch)} https://github.com/${cfg.repoFullName}.git ${WORKDIR}`,
    600,
    { GITHUB_TOKEN: cfg.githubToken },
  );
}

async function create(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<Sandbox> {
  const sandbox = await daytona().create(
    {
      labels: { 'selvedge/org': orgId, 'selvedge/project': projectId },
      public: false,
      autoStopInterval: SANDBOX_IDLE_MINUTES, // the sandbox-cost guard
      // The GitHub token is deliberately NOT baked in here. A sandbox outlives
      // any token by days; an installation token pinned at creation would be an
      // hour's worth of working and then a puzzling failure. It travels with
      // each command instead, fresh per request.
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeCodeOauthToken },
    },
    { timeout: 300 },
  );
  try {
    await prepare(sandbox, cfg);
  } catch (err) {
    await sandbox.delete(60).catch(() => undefined);
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
 */
export async function ensureSandbox(db: Db, orgId: string, projectId: string, cfg: SandboxConfig): Promise<Sandbox> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.sandboxId) return create(db, orgId, projectId, cfg);

  let sandbox: Sandbox;
  try {
    sandbox = await daytona().get(build.sandboxId);
  } catch (err) {
    if (err instanceof DaytonaNotFoundError) {
      await clearSandbox(db, orgId, projectId);
      return create(db, orgId, projectId, cfg);
    }
    throw err;
  }

  if (sandbox.state && DEAD_STATES.has(sandbox.state)) {
    await clearSandbox(db, orgId, projectId);
    return create(db, orgId, projectId, cfg);
  }
  if (sandbox.state !== 'started') await sandbox.start(300);
  return sandbox;
}

/** Stop a project's sandbox now (owner left / done). Idle auto-stop is the backstop; this is the explicit one. */
export async function stopSandbox(db: Db, orgId: string, projectId: string): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.sandboxId) return;
  await daytona()
    .get(build.sandboxId)
    .then((s) => (s.state === 'started' ? s.stop() : undefined))
    .catch(() => undefined);
}

/** Permanently delete a project's sandbox and clear its build state. */
export async function deleteSandbox(db: Db, orgId: string, projectId: string): Promise<void> {
  const build = await getBuild(db, orgId, projectId);
  if (build?.sandboxId) {
    await daytona()
      .get(build.sandboxId)
      .then((s) => s.delete(60))
      .catch(() => undefined);
  }
  await clearSandbox(db, orgId, projectId);
}
