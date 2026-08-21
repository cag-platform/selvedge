import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CompanionApi } from './api.js';
import { repoFor } from './git.js';

/**
 * `selvedge-context` — the write half of the loop: the project's own context,
 * served to whatever agent the owner is using today.
 *
 * Three tools, all READ-ONLY. An agent consumes context here; it never writes
 * memory. That is not a v1 shortcut — the pack's whole value is that it is
 * grounded in what actually happened, and a tool that let any agent in any repo
 * edit what Selvedge believes would turn it into a place agents store their own
 * assumptions.
 *
 * Resolution: an agent usually knows only the directory it is sitting in, so
 * every tool takes an optional project and otherwise resolves the current
 * repository against the projects this key can see. When it can't tell, it says
 * which projects exist rather than picking one.
 */

const SERVER_NAME = 'selvedge-context';

type Resolution = { ok: true; projectId: string; name: string } | { ok: false; message: string };

export async function resolveProject(
  api: CompanionApi,
  requested: string | undefined,
  cwd: string,
  findRepo: (dir: string) => Promise<string | null> = repoFor,
): Promise<Resolution> {
  const listed = await api.projects();
  if (!listed.ok) return { ok: false, message: `I couldn't reach Selvedge: ${listed.error}` };
  const projects = listed.value.projects;
  if (projects.length === 0) return { ok: false, message: 'This Selvedge account has no projects yet.' };

  if (requested) {
    const match = projects.find((p) => p.id === requested || p.name.toLowerCase() === requested.toLowerCase());
    return match
      ? { ok: true, projectId: match.id, name: match.name }
      : { ok: false, message: `I don't have a project called "${requested}". I know: ${projects.map((p) => p.id).join(', ')}.` };
  }

  const repo = await findRepo(cwd).catch(() => null);
  const byRepo = repo ? projects.find((p) => p.repo?.toLowerCase() === repo.toLowerCase()) : undefined;
  if (byRepo) return { ok: true, projectId: byRepo.id, name: byRepo.name };

  return {
    ok: false,
    message: `I can't tell which project this directory belongs to${repo ? ` (its repo is ${repo})` : ''}. Ask again with one of: ${projects
      .map((p) => p.id)
      .join(', ')}.`,
  };
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function buildContextServer(
  api: CompanionApi,
  cwd: () => string = () => process.cwd(),
  /** Injected so the server can be driven by a real MCP client in tests, without a real repository. */
  findRepo: (dir: string) => Promise<string | null> = repoFor,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });

  server.registerTool(
    'get_project_context',
    {
      title: 'What this project is',
      description:
        "Selvedge's context pack for the project you are working in: what it is, who it serves, what breaking it costs, how it is built, what changed lately, and what is open. Read this before making changes — it is grounded in what actually happened, not in what anyone claimed.",
      inputSchema: { project: z.string().optional().describe('Project id, if the directory does not identify it') },
    },
    async ({ project }) => {
      const resolved = await resolveProject(api, project, cwd(), findRepo);
      if (!resolved.ok) return text(resolved.message);
      const context = await api.context(resolved.projectId);
      return text(context.ok ? context.value.text : `I couldn't fetch that project's context: ${context.error}`);
    },
  );

  server.registerTool(
    'get_recent_changes',
    {
      title: 'What changed lately',
      description:
        'What has happened to this project recently — what shipped, what broke, what was verified, and any coding sessions Selvedge observed from outside. Sessions it only observed are marked as such: it did not run or check that work.',
      inputSchema: {
        project: z.string().optional().describe('Project id, if the directory does not identify it'),
        days: z.number().int().min(1).max(90).optional().describe('How far back to look. Defaults to 14.'),
      },
    },
    async ({ project, days }) => {
      const resolved = await resolveProject(api, project, cwd(), findRepo);
      if (!resolved.ok) return text(resolved.message);
      const changes = await api.changes(resolved.projectId, days ?? 14);
      if (!changes.ok) return text(`I couldn't fetch recent changes: ${changes.error}`);
      return text(
        changes.value.changes.length
          ? `What changed in ${resolved.name} in the last ${changes.value.days} days:\n${changes.value.changes.map((c) => `- ${c}`).join('\n')}`
          : `Selvedge saw nothing change in ${resolved.name} in the last ${changes.value.days} days. That means it saw nothing — not that nothing happened.`,
      );
    },
  );

  server.registerTool(
    'get_open_issues',
    {
      title: 'What is open',
      description:
        'What is waiting on someone in this project: changes awaiting the owner, problems reported in the last week, gaps Selvedge cannot see through, and known flakiness not worth chasing.',
      inputSchema: { project: z.string().optional().describe('Project id, if the directory does not identify it') },
    },
    async ({ project }) => {
      const resolved = await resolveProject(api, project, cwd(), findRepo);
      if (!resolved.ok) return text(resolved.message);
      const issues = await api.issues(resolved.projectId);
      if (!issues.ok) return text(`I couldn't fetch open issues: ${issues.error}`);
      return text(
        issues.value.issues.length
          ? `Open in ${resolved.name}:\n${issues.value.issues.map((i) => `- ${i}`).join('\n')}`
          : `Nothing is waiting on anyone in ${resolved.name}.`,
      );
    },
  );

  return server;
}

/** Run the server on stdio — the transport every MCP client mounts a local server with. */
export async function runContextServer(api: CompanionApi): Promise<void> {
  const server = buildContextServer(api);
  await server.connect(new StdioServerTransport());
}
