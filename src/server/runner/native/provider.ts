import type { Db } from '../../db/client.js';
import { getPack } from '../../packs/store.js';
import type { Card } from '../../cards/types.js';
import type { CardWorkspaceRuntime, AgentContext, AgentStepResult } from '../types.js';
import type { WorkspaceHandle } from '../../workspace/types.js';
import { WORKDIR, shellQuote, claudeCommand, buildAgentPrompt, parseResult, parseToolEvents, resultToStep } from '../workers/claudeCommand.js';
import { resolveRepoToken } from '../../build/repoToken.js';
import { lookupRepoInfo } from '../../build/repoInfo.js';
import { resolveBuilderAuth } from '../../build/builderAuth.js';
import {
  adaptDevelopmentWorkspace, developmentWorkspaceRuntime, setDevelopmentSecret,
  type DevelopmentWorkspace,
} from '../../build/sandbox.js';

type WorkspaceEnv = { model?: string };

/**
 * Governed-card adapter for Selvedge Development Workspaces.
 */
export function nativeWorkspaceEngine(db: Db, cfg: WorkspaceEnv): { workspaceRuntime: CardWorkspaceRuntime; agentStep: (ctx: AgentContext) => Promise<AgentStepResult> } {
  const workspaces = new Map<string, DevelopmentWorkspace>();

  async function repoForCard(card: Card): Promise<{ repoFullName: string; branch: string; token: string; empty: boolean }> {
    const pack = await getPack(db, card.orgId, card.projectId);
    const source = pack?.topology.sources.find((entry) => entry.connector === 'github');
    if (!source) throw new Error('this project has no GitHub source to change');
    const token = await resolveRepoToken(db, card.orgId, source.resource_id);
    if (!token.ok) throw new Error(token.reason);
    const info = await lookupRepoInfo(token.token, source.resource_id);
    if (!info.ok) throw new Error(info.reason);
    return { repoFullName: source.resource_id, branch: info.defaultBranch, token: token.token, empty: info.empty };
  }

  const workspaceRuntime: CardWorkspaceRuntime = {
    async createWorkspace(card: Card): Promise<WorkspaceHandle> {
      const repo = await repoForCard(card);
      const gitGrant = `card-github:${card.id}`;
      setDevelopmentSecret(gitGrant, repo.token);
      try {
        const workspace = await developmentWorkspaceRuntime().createWorkspace({
          orgId: card.orgId, projectId: card.projectId, purpose: 'development',
          source: { kind: 'git', repository: `https://github.com/${repo.repoFullName}.git`, ref: repo.branch, credentialGrant: gitGrant, empty: repo.empty },
          ttlMinutes: 180, idleStopMinutes: 15,
          network: { default: 'deny', allowedHosts: ['github.com', 'api.github.com', 'registry.npmjs.org', 'api.anthropic.com'] },
          secrets: [{ id: gitGrant, name: 'GITHUB_TOKEN', exposure: 'command' }],
          labels: { cardId: card.id, projectId: card.projectId },
        });
        workspaces.set(workspace.id, adaptDevelopmentWorkspace(workspace));
        return { id: workspace.id, state: 'ready' };
      } catch (error) {
        setDevelopmentSecret(gitGrant, null);
        throw error;
      }
    },

    async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
      const workspace = workspaces.get(handle.id);
      if (workspace) await workspace.workspace.destroy();
      workspaces.delete(handle.id);
    },
  };

  async function agentStep(ctx: AgentContext): Promise<AgentStepResult> {
    const workspace = workspaces.get(ctx.workspace.id);
    if (!workspace) throw new Error('Development Workspace is no longer available');
    const auth = await resolveBuilderAuth(db, ctx.card.orgId, 'claude-code');
    if (!auth.ok) throw new Error(auth.note);
    const command = claudeCommand(buildAgentPrompt(ctx.card), cfg.model);
    const result = await workspace.process.executeCommand(command, undefined, {
      [auth.auth.envVar]: auth.auth.secret,
    }, 1800);
    const step = resultToStep(parseResult(result.result ?? ''));

    const branch = `selvedge/${ctx.card.id}`;
    const push = [
      `cd ${WORKDIR}`,
      `git checkout -b ${shellQuote(branch)} 2>/dev/null || git checkout ${shellQuote(branch)}`,
      'git add -A',
      `git diff --cached --quiet || (git commit -q -m ${shellQuote(`Selvedge: ${ctx.card.title}`)} && git push -u origin ${shellQuote(branch)})`,
    ].join(' && ');
    const pushToken = await repoForCard(ctx.card).then((repo) => repo.token).catch(() => null);
    const pushed = pushToken
      ? await workspace.process.executeCommand(push, undefined, { GITHUB_TOKEN: pushToken }, 300).catch(() => null)
      : null;
    const changed = pushed?.exitCode === 0 && !/nothing to commit/i.test(pushed?.result ?? '');
    const { tools } = parseToolEvents(result.result ?? '');
    return {
      ...step,
      note: `${step.note}.${changed ? ` Pushed to branch ${branch} for your review.` : ' No code change was needed.'}`,
      ...(tools.length ? { tools } : {}),
    };
  }

  return { workspaceRuntime, agentStep };
}
