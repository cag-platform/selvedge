import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { getBuild, setBuild } from './store.js';
import { deleteSandbox, ensureSandbox, WORKDIR, type SandboxConfig } from './sandbox.js';
import type { ExecuteInSandbox } from './agent.js';
import { pathSignals } from '../cards/triggers.js';
import { HOST_TOPOLOGY_CONNECTORS } from '../connectors/registry.js';
import { classifyRisk, gateFor } from '../cards/risk.js';
import { observeDeploy, type ObserveResult } from '../verify/observe.js';
import { runCheck } from '../monitor/probe.js';
import { getPack } from '../packs/store.js';
import { ensureWorkshopThread } from '../threads/store.js';
import { stampedCommitMessage } from '../provenance/trailer.js';
import type { ContextPack } from '../../shared/types/pack.js';

/**
 * Ship — the one moment the workshop touches the real world, and therefore the
 * one moment Selvedge's safety bites (the governance decision: build freely,
 * gate at ship). What it does, plainly:
 *
 *   1. Looks at WHICH FILES actually changed and classifies the risk from them —
 *      a change that touched payments/auth/user-data code is sensitive and
 *      cannot ship without the owner confirming a recent backup. Judging the
 *      diff, not the conversation: an innocent ask that ended up editing
 *      checkout code is still gated.
 *   2. Commits everything and pushes it to the project's branch — the same push
 *      the owner would make. The host deploys it from there (that's how their
 *      app already ships), and Selvedge's existing watchers — the deploy poller
 *      and the health monitor — pick it up from the moment it lands.
 *   3. Records the ship on the thread and in the runs, with the commit id, and
 *      arms the undo: a rollback is a real `git revert` of exactly that commit,
 *      pushed the same way.
 *   4. STAMPS the commit with the thread it came from — `Selvedge-Session: <id>`
 *      as a git trailer (provenance/trailer.ts). The record already knew which
 *      conversation asked for the change; the stamp puts that join in the repo
 *      itself, where git log can read it and where it survives Selvedge. It is
 *      evidence, never a gate: a ship whose thread can't be resolved still
 *      ships, unstamped.
 *
 * Execution is injectable so the whole flow is tested without a live workspace.
 */

export type ShipOutcome =
  | { outcome: 'shipped'; commit: string; message: string }
  | { outcome: 'nothing_to_ship'; message: string }
  | { outcome: 'backup_required'; message: string }
  | { outcome: 'failed'; message: string };

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Authenticate one Git network operation from the command-scoped token.
 * The helper contains only the environment variable name; the token itself
 * never enters the command string, logs, checkout config, or remote URL.
 */
export function authenticatedGit(args: string): string {
  const helper = shellQuote('!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f');
  return `git -c credential.helper=${helper} ${args}`;
}

/** Roles that mean "something out there deploys this repo". */
const HOST_ROLES = new Set(['production_host', 'preview_host']);
const HOST_CONNECTORS = HOST_TOPOLOGY_CONNECTORS;

/**
 * What we can honestly say happens after the push.
 *
 * Ship used to tell every owner "your host is taking it live now" — an
 * assumption that they had already wired push-to-deploy. For a project where
 * nobody ever did (an app Selvedge itself just created, say), that sentence is
 * the exact false all-clear the whole product exists to prevent: the ship
 * succeeds, nothing deploys, and Selvedge says it did.
 */
export type ShipReach = 'watched' | 'host_only' | 'pushed_only';

export function shipReach(pack: ContextPack | null): ShipReach {
  if (pack?.identity.links?.live_url) return 'watched';
  const hosted = (pack?.topology.sources ?? []).some(
    (s) => HOST_CONNECTORS.has(s.connector) || HOST_ROLES.has(s.role),
  );
  return hosted ? 'host_only' : 'pushed_only';
}

/** The line the owner reads on the thread — true for each of the three cases. */
export function shipMessageFor(reach: ShipReach): string {
  if (reach === 'watched') {
    return "Shipped — your host is taking it live now, and I'm watching it land. If anything looks wrong you'll hear from me, and you can undo this ship from here.";
  }
  if (reach === 'host_only') {
    return "Shipped — your host should pick it up from here. I don't have a live web address for this project, so I can't watch it land; add one on the project page and I'll keep an eye on the next one. You can undo this ship from here.";
  }
  return "Saved and pushed to GitHub — but nothing is set up to put this project online yet, so it is NOT live. The work is safely stored and you can undo this ship from here.";
}

export async function shipChanges(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  opts: { backupConfirmed?: boolean; summary?: string; threadId?: string } = {},
  deps: { execute?: ExecuteInSandbox; destroyWorkspace?: () => Promise<void> } = {},
): Promise<ShipOutcome> {
  const build = await getBuild(db, orgId, projectId);
  // A Mac/Apple build returns as a durable checkpoint rather than an attached
  // cloud workspace. `ensureSandbox` below rehydrates either form into the
  // same disposable shipping workspace, so the review decision must not care
  // where the coding agent happened to run.
  if (!build?.stagedChangesReady || (!build.sandboxId && !build.checkpointArchiveBase64)) {
    return { outcome: 'nothing_to_ship', message: "There's nothing waiting to ship — ask for a change first." };
  }

  const execute: ExecuteInSandbox =
    deps.execute ??
    (await (async () => {
      const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
      // Pushing needs a live GitHub credential, and the sandbox holds none —
      // it travels with the command. See sandbox.ts on why it isn't baked in.
      return (command: string, timeoutSec: number, env?: Record<string, string>) =>
        sandbox.process.executeCommand(command, undefined, { GITHUB_TOKEN: cfg.githubToken, ...(env ?? {}) }, timeoutSec);
    })());

  // 1) The gate, judged on the actual changed files.
  // Include commits that a previous ship attempt created locally but failed to
  // push. A retry must remain idempotent: those files are still pending work,
  // even though the working tree itself is now clean.
  const diff = await execute(
    `cd ${WORKDIR} && { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; git diff --name-only origin/${shellQuote(build.branch)}...HEAD; } | sort -u`,
    60,
  );
  if (diff.exitCode !== 0) {
    return { outcome: 'failed', message: "I couldn't read what changed, so I didn't ship anything." };
  }
  const paths = (diff.result ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    await setBuild(db, orgId, projectId, { stagedChangesReady: false, dirtyRunId: null, dirtyThreadId: null, dirtyAgent: null, dirtyObservedAt: null });
    return { outcome: 'nothing_to_ship', message: 'The workshop has no actual file changes to ship.' };
  }
  const risk = classifyRisk(pathSignals(paths));
  if (gateFor(risk) === 'hard' && opts.backupConfirmed !== true) {
    return {
      outcome: 'backup_required',
      message:
        'This change touches something sensitive — payments, logins, or customer data. Confirm you have a recent backup you could restore, and I\'ll ship it.',
    };
  }

  // 2) Commit and push — the owner's own shipping path, with the session stamp
  // riding along in the commit message.
  const summary = (opts.summary ?? 'changes from the workshop').slice(0, 120);
  const threadId = opts.threadId ?? (await ensureWorkshopThread(db, orgId, projectId).then((t) => t.id).catch(() => null));
  const push = await execute(
    [
      `cd ${WORKDIR}`,
      'git add -A',
      `git diff --cached --quiet || git commit -q -m ${shellQuote(stampedCommitMessage(`Selvedge: ${summary}`, threadId))}`,
      authenticatedGit(`push origin ${shellQuote(build.branch)}`),
      'git rev-parse HEAD',
    ].join(' && '),
    300,
  );
  if (push.exitCode !== 0) {
    return { outcome: 'failed', message: `The push didn't go through: ${(push.result ?? '').trim().slice(-300)}` };
  }
  const commit = (push.result ?? '').trim().split('\n').at(-1)?.slice(0, 40) ?? 'unknown';

  // 3) The record and the undo lever. changedPaths is the exact file list the
  // risk gate judged above — persisted so a shipped commit is auditable: what
  // went out, and why it was (or wasn't) hard-gated.
  await db.insert(agentRuns).values({
    id: ulid(),
    orgId,
    projectId,
    threadId,
    prompt: `ship: ${summary}`,
    status: 'succeeded',
    commitSha: commit,
    changedPaths: paths,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  // Say only what is true for THIS project: whether anything is actually
  // wired to put the push online, and whether we can watch it land.
  const reach = shipReach(await getPack(db, orgId, projectId).catch(() => null));
  const line = shipMessageFor(reach);
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId,
    threadId,
    role: 'agent',
    content: line,
    meta: { ship: { commit, reach } },
  });
  // The development workspace is disposable. Once GitHub has accepted the
  // commit and the audit record exists, destroy the container and clear every
  // session/preview handle that pointed into it. A failed push returns above,
  // deliberately preserving the workspace so the owner can retry.
  await (deps.destroyWorkspace ?? (() => deleteSandbox(db, orgId, projectId)))().catch((error) => {
    console.error(`shipped ${projectId}, but could not destroy its development workspace:`, error);
  });

  return { outcome: 'shipped', commit, message: line };
}

/** How long we watch the live app after a ship, and how often we look. The
 *  window is long enough to cover the host's build (~minutes) plus real serving
 *  time on the new version. */
export const OBSERVE_WINDOW_MS = 12 * 60 * 1000;
export const OBSERVE_INTERVAL_MS = 30 * 1000;

/**
 * The post-ship watch, with the auto-undo armed. After a ship, watch the live
 * app across the window; a CONFIRMED break (the monitor's two-failure debounce —
 * one blip never rolls anything back) reverts exactly that commit and tells the
 * thread. Holding gets a quiet line too, so a good ship is confirmed out loud
 * rather than assumed. Everything injected for tests; the defaults are the real
 * health probe and the real revert.
 */
export async function observeAfterShip(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  commit: string,
  liveUrl: string,
  deps: {
    probe?: () => Promise<{ up: boolean; latencyMs: number; detail: string | null }>;
    rollback?: () => Promise<{ ok: boolean; message: string }>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    windowMs?: number;
    intervalMs?: number;
    /** The conversation to speak into; defaults to the project's workshop thread. */
    threadId?: string;
  } = {},
): Promise<ObserveResult> {
  const threadId = deps.threadId ?? (await ensureWorkshopThread(db, orgId, projectId).then((t) => t.id).catch(() => null));
  let undoOk = false;
  let undoMessage = '';
  const observed = await observeDeploy({
    probe: deps.probe ?? (() => runCheck({ kind: 'http', url: liveUrl })),
    rollback: async () => {
      const out = await (deps.rollback ?? (() => rollbackShip(db, orgId, projectId, cfg, commit)))();
      undoOk = out.ok;
      undoMessage = out.message;
    },
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
    windowMs: deps.windowMs ?? OBSERVE_WINDOW_MS,
    intervalMs: deps.intervalMs ?? OBSERVE_INTERVAL_MS,
  });

  if (observed.outcome === 'broke') {
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId,
      threadId,
      role: 'agent',
      // Never claim "undone" unless the revert actually applied.
      content: undoOk
        ? `That ship broke the live app — it stopped answering, twice in a row. I've already undone it (reverted ${commit.slice(0, 7)}), and your host is rolling back to the version that worked.`
        : `That ship broke the live app, and I tried to undo it automatically but the undo didn't apply cleanly: ${undoMessage} Please look when you can.`,
    });
  } else {
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId,
      threadId,
      role: 'agent',
      content: `Watched the live app for ${Math.round((deps.windowMs ?? OBSERVE_WINDOW_MS) / 60000)} minutes after that ship — it's standing. All good.`,
    });
  }
  return observed;
}

/** Undo a ship: a real `git revert` of exactly that commit, pushed the same way. */
export async function rollbackShip(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  commit: string,
  deps: { execute?: ExecuteInSandbox; threadId?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { ok: false, message: "That doesn't look like a commit I shipped." };

  const build = await getBuild(db, orgId, projectId);
  const threadId = deps.threadId ?? (await ensureWorkshopThread(db, orgId, projectId).then((t) => t.id).catch(() => null));
  const execute: ExecuteInSandbox =
    deps.execute ??
    (await (async () => {
      const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
      // Pushing needs a live GitHub credential, and the sandbox holds none —
      // it travels with the command. See sandbox.ts on why it isn't baked in.
      return (command: string, timeoutSec: number, env?: Record<string, string>) =>
        sandbox.process.executeCommand(command, undefined, { GITHUB_TOKEN: cfg.githubToken, ...(env ?? {}) }, timeoutSec);
    })());

  const res = await execute(
    [
      `cd ${WORKDIR}`,
      authenticatedGit(`pull --ff-only origin ${shellQuote(build?.branch ?? 'main')}`),
      `git revert --no-edit ${shellQuote(commit)}`,
      authenticatedGit(`push origin ${shellQuote(build?.branch ?? 'main')}`),
    ].join(' && '),
    300,
  );
  if (res.exitCode !== 0) {
    return { ok: false, message: `I couldn't cleanly undo that — ${(res.result ?? '').trim().slice(-200)}. Nothing was force-pushed; your history is untouched.` };
  }

  // An undo is a decision too — it gets a run row like the ship it reverses,
  // so the record shows both directions of the change.
  await db.insert(agentRuns).values({
    id: ulid(),
    orgId,
    projectId,
    threadId,
    prompt: `undo: revert of ${commit.slice(0, 7)}`,
    status: 'succeeded',
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId,
    threadId,
    role: 'agent',
    content: `Undone — I reverted that ship (${commit.slice(0, 7)}) and pushed the revert. Your host is rolling back to the previous version now.`,
  });
  return { ok: true, message: 'Undone — the revert is pushed and your host is rolling back.' };
}
