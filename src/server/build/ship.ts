import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, type SandboxConfig } from './sandbox.js';
import type { ExecuteInSandbox } from './agent.js';
import { pathSignals } from '../cards/triggers.js';
import { classifyRisk, gateFor } from '../cards/risk.js';

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
 *
 * Execution is injectable so the whole flow is tested without Daytona.
 */

export type ShipOutcome =
  | { outcome: 'shipped'; commit: string; message: string }
  | { outcome: 'nothing_to_ship'; message: string }
  | { outcome: 'backup_required'; message: string }
  | { outcome: 'failed'; message: string };

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export async function shipChanges(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  opts: { backupConfirmed?: boolean; summary?: string } = {},
  deps: { execute?: ExecuteInSandbox } = {},
): Promise<ShipOutcome> {
  const build = await getBuild(db, orgId, projectId);
  if (!build?.stagedChangesReady || !build.sandboxId) {
    return { outcome: 'nothing_to_ship', message: "There's nothing waiting to ship — ask for a change first." };
  }

  const execute: ExecuteInSandbox =
    deps.execute ??
    (await (async () => {
      const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
      return (command: string, timeoutSec: number) => sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
    })());

  // 1) The gate, judged on the actual changed files.
  const diff = await execute(`cd ${WORKDIR} && { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u`, 60);
  if (diff.exitCode !== 0) {
    return { outcome: 'failed', message: "I couldn't read what changed, so I didn't ship anything." };
  }
  const paths = (diff.result ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    await setBuild(db, orgId, projectId, { stagedChangesReady: false });
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

  // 2) Commit and push — the owner's own shipping path.
  const summary = (opts.summary ?? 'changes from the workshop').slice(0, 120);
  const push = await execute(
    [
      `cd ${WORKDIR}`,
      'git add -A',
      `git commit -q -m ${shellQuote(`Selvedge: ${summary}`)}`,
      `git push origin ${shellQuote(build.branch)}`,
      'git rev-parse HEAD',
    ].join(' && '),
    300,
  );
  if (push.exitCode !== 0) {
    return { outcome: 'failed', message: `The push didn't go through: ${(push.result ?? '').trim().slice(-300)}` };
  }
  const commit = (push.result ?? '').trim().split('\n').at(-1)?.slice(0, 40) ?? 'unknown';

  // 3) The record and the undo lever.
  await db.insert(agentRuns).values({
    id: ulid(),
    orgId,
    projectId,
    prompt: `ship: ${summary}`,
    status: 'succeeded',
    commitSha: commit,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId,
    role: 'agent',
    content: `Shipped — your host is taking it live now, and I'm watching it land. If anything looks wrong you'll hear from me, and you can undo this ship from here.`,
    meta: { ship: { commit } },
  });
  await setBuild(db, orgId, projectId, { stagedChangesReady: false });

  return { outcome: 'shipped', commit, message: 'Shipped. Your host is taking it live; the watcher has it from here.' };
}

/** Undo a ship: a real `git revert` of exactly that commit, pushed the same way. */
export async function rollbackShip(
  db: Db,
  orgId: string,
  projectId: string,
  cfg: SandboxConfig,
  commit: string,
  deps: { execute?: ExecuteInSandbox } = {},
): Promise<{ ok: boolean; message: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { ok: false, message: "That doesn't look like a commit I shipped." };

  const build = await getBuild(db, orgId, projectId);
  const execute: ExecuteInSandbox =
    deps.execute ??
    (await (async () => {
      const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
      return (command: string, timeoutSec: number) => sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
    })());

  const res = await execute(
    [`cd ${WORKDIR}`, `git pull --ff-only origin ${shellQuote(build?.branch ?? 'main')}`, `git revert --no-edit ${shellQuote(commit)}`, `git push origin ${shellQuote(build?.branch ?? 'main')}`].join(' && '),
    300,
  );
  if (res.exitCode !== 0) {
    return { ok: false, message: `I couldn't cleanly undo that — ${(res.result ?? '').trim().slice(-200)}. Nothing was force-pushed; your history is untouched.` };
  }

  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId,
    role: 'agent',
    content: `Undone — I reverted that ship (${commit.slice(0, 7)}) and pushed the revert. Your host is rolling back to the previous version now.`,
  });
  return { ok: true, message: 'Undone — the revert is pushed and your host is rolling back.' };
}
