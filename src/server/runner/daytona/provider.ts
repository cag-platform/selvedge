import { Daytona, type Sandbox } from '@daytonaio/sdk';
import type { Db } from '../../db/client.js';
import { getPack } from '../../packs/store.js';
import type { Card } from '../../cards/types.js';
import type { SandboxProvider, SandboxHandle, AgentContext, AgentStepResult } from '../types.js';
import { WORKDIR, shellQuote, claudeCommand, buildAgentPrompt, parseResult, parseToolEvents, resultToStep } from './agentCommand.js';
import { resolveRepoToken } from '../../build/repoToken.js';
import { resolveBuilderAuth } from '../../build/builderAuth.js';

/**
 * The live Daytona build engine — ported from Toile's server/sandbox + agent
 * runner, reshaped to Selvedge's injected runner seams (SandboxProvider +
 * agentStep). This is network code against Daytona and the Claude Code CLI; it
 * is verified against Toile's working implementation but NOT re-run live here,
 * so it is unverified-until-live like the host connectors. The pure decisions
 * (prompt, command, cost) live in agentCommand.ts and ARE tested.
 *
 * One sandbox per card: created on first sight, torn down when the runner is
 * done (the runner's finally). The customer's repo is cloned via a GitHub token
 * injected only through Daytona's env mechanism — never written to disk or a URL.
 * That token is minted per card from the org's own app installation (see
 * build/repoToken.ts), so the runner can reach exactly the repos the owner
 * connected and no others.
 */

let client: Daytona | null = null;
function daytona(): Daytona {
  if (!client) client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  return client;
}

/**
 * What the deployment supplies to a card run. No model credential: which
 * account a card's agent burns is the CARD'S ORG's question, answered per step
 * in `agentStep` (build/builderAuth.ts), the same as a workshop turn.
 */
type SandboxEnv = {
  model?: string;
};

async function runIn(
  sandbox: Sandbox,
  label: string,
  command: string,
  timeoutSec: number,
  env?: Record<string, string>,
): Promise<string> {
  const res = await sandbox.process.executeCommand(command, undefined, env, timeoutSec);
  if (res.exitCode !== 0) {
    throw new Error(`Sandbox step "${label}" failed (exit ${res.exitCode}): ${res.result}`);
  }
  return res.result ?? '';
}

/** Install Node 20 (if missing) and the Claude Code CLI. Ported from Toile's setupSandbox. */
async function setupSandbox(sandbox: Sandbox): Promise<void> {
  await runIn(
    sandbox,
    'create workdir',
    `mkdir -p ${WORKDIR} 2>/dev/null || (sudo -n mkdir -p ${WORKDIR} && sudo -n chown -R "$(id -un)" ${WORKDIR})`,
    60,
  );
  const nodeCheck = await sandbox.process.executeCommand('node --version || echo MISSING', undefined, undefined, 30);
  const major = /v(\d+)\./.exec(nodeCheck.result ?? '')?.[1];
  if (!major || Number(major) < 20) {
    await runIn(sandbox, 'install node 20', 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs', 600);
  }
  await runIn(
    sandbox,
    'install claude code',
    `sudo -n env "PATH=$PATH" npm install -g @anthropic-ai/claude-code || npm install -g --prefix "$HOME/.npm-global" @anthropic-ai/claude-code`,
    600,
  );
}

/** Clone the customer's repo. Ported from Toile's setupImportedRepo (credential helper, no token on disk). */
async function cloneRepo(sandbox: Sandbox, repoFullName: string, branch: string, token: string): Promise<void> {
  const helper = '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f';
  await runIn(
    sandbox,
    'configure git',
    `git config --global user.name "Selvedge" && git config --global user.email "selvedge@users.noreply.github.com" && git config --global credential.helper ${shellQuote(helper)}`,
    30,
  );
  await runIn(sandbox, 'clone', `git clone --branch ${shellQuote(branch)} https://github.com/${repoFullName}.git ${WORKDIR}`, 600, {
    GITHUB_TOKEN: token,
  });
}

/**
 * Build the SandboxProvider + agentStep for the runner. What the sandbox needs
 * from the platform (the Claude auth token, the model) is passed in, so no env
 * is read below this line and the whole thing stays injectable. GitHub is the
 * exception by design: it is per-org, per-repo and short-lived, so it is
 * resolved from the card rather than held.
 */
export function daytonaEngine(db: Db, cfg: SandboxEnv): { sandbox: SandboxProvider; agentStep: (ctx: AgentContext) => Promise<AgentStepResult> } {
  /**
   * Where the work happens and what may reach it. The token is minted here
   * rather than held by the engine because installation tokens expire within
   * the hour and a card can sit in the queue longer than that.
   */
  async function repoForCard(card: Card): Promise<{ repoFullName: string; branch: string; token: string }> {
    const pack = await getPack(db, card.orgId, card.projectId);
    const source = pack?.topology.sources.find((s) => s.connector === 'github');
    if (!source) throw new Error('this project has no GitHub source to change');
    const token = await resolveRepoToken(db, card.orgId, source.resource_id);
    if (!token.ok) throw new Error(token.reason);
    return { repoFullName: source.resource_id, branch: 'main', token: token.token };
  }

  const sandbox: SandboxProvider = {
    async create(card: Card): Promise<SandboxHandle> {
      const { repoFullName, branch, token } = await repoForCard(card);
      const box = await daytona().create(
        {
          labels: { 'selvedge/card': card.id, 'selvedge/project': card.projectId },
          public: false,
          // NOTHING SECRET HERE ON PURPOSE. The GitHub token outlives nothing
          // and the sandbox outlives it, so it rides each command; the agent's
          // model credential now does the same, and is the card's org's rather
          // than the deployment's. See build/builderAuth.ts.
        },
        { timeout: 300 },
      );
      try {
        await setupSandbox(box);
        await cloneRepo(box, repoFullName, branch, token);
      } catch (err) {
        await box.delete(60).catch(() => undefined);
        throw err;
      }
      return { id: box.id };
    },

    async destroy(handle: SandboxHandle): Promise<void> {
      const box = await daytona().get(handle.id);
      await box.delete(60);
    },
  };

  async function agentStep(ctx: AgentContext): Promise<AgentStepResult> {
    // Whose account this card's work goes on — the card's org, resolved now
    // rather than baked into the sandbox at creation. A card run is the second
    // path that starts an agent, and it had the same bug the workshop turn did.
    const auth = await resolveBuilderAuth(db, ctx.card.orgId, 'claude-code');
    if (!auth.ok) {
      // Nothing spent, nothing changed, and the reason is the one the owner can
      // act on. Done, because retrying without a credential just burns the cap.
      return { spentCents: 0, done: true, note: auth.note };
    }
    const box = await daytona().get(ctx.sandbox.id);
    const command = claudeCommand(buildAgentPrompt(ctx.card), cfg.model, null, 'build', auth.auth);
    // One turn; generous ceiling. The runner's cap is the real spend guard.
    const res = await box.process.executeCommand(command, undefined, undefined, 1800);
    const step = resultToStep(parseResult(res.result ?? ''));

    // Preserve the work: commit any change and push it to a review branch, so the
    // sandbox can be torn down without losing it — and so a change reaches the
    // owner as a branch to merge, NEVER auto-deployed to production. If nothing
    // changed, there is nothing to push.
    const branch = `selvedge/${ctx.card.id}`;
    const push = [
      `cd ${WORKDIR}`,
      `git checkout -b ${shellQuote(branch)} 2>/dev/null || git checkout ${shellQuote(branch)}`,
      'git add -A',
      // Only commit + push when there is actually a change.
      `git diff --cached --quiet || (git commit -q -m ${shellQuote(`Selvedge: ${ctx.card.title}`)} && git push -u origin ${shellQuote(branch)})`,
    ].join(' && ');
    // A fresh token: the clone's may be an hour old by the time a turn ends.
    const pushToken = await repoForCard(ctx.card).then((r) => r.token).catch(() => null);
    const pushed = pushToken
      ? await box.process.executeCommand(push, undefined, { GITHUB_TOKEN: pushToken }, 300).catch(() => null)
      : null;
    const changed = pushed?.exitCode === 0 && !/nothing to commit/i.test(pushed?.result ?? '');
    const branchNote = changed ? ` Pushed to branch ${branch} for your review.` : ' No code change was needed.';

    // The step's flight record: every tool use with its outcome, bounded.
    // Rides the spend act's meta so a card's history shows the actual work,
    // not just that money was spent.
    const { tools } = parseToolEvents(res.result ?? '');
    return { ...step, note: `${step.note}.${branchNote}`, ...(tools.length ? { tools } : {}) };
  }

  return { sandbox, agentStep };
}
