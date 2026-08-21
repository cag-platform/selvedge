import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContextServer, resolveProject } from '../../src/cli/mcp.js';
import type { CompanionApi } from '../../src/cli/api.js';

/**
 * The MCP server, driven by a real MCP client over an in-memory transport —
 * so what is tested is what an agent actually gets when it mounts this, not
 * what the functions return in isolation.
 *
 * The properties that matter: three tools and no fourth (this is read-only by
 * design), a project resolved from the repo the agent is sitting in, and — the
 * load-bearing one — an honest sentence whenever it cannot tell rather than a
 * confident answer about the wrong project.
 */
const PROJECTS = [
  { id: 'loom', name: 'Loom', repo: 'acme/loom' },
  { id: 'ravel', name: 'Ravel', repo: 'acme/ravel' },
];

function fakeApi(over: Partial<Record<keyof CompanionApi, unknown>> = {}): CompanionApi {
  return {
    projects: async () => ({ ok: true, value: { projects: PROJECTS } }),
    context: async (id: string) => ({ ok: true, value: { project: { id, name: 'Loom' }, text: `WHAT THIS IS\n- Loom — a curtain shop.` } }),
    changes: async (_id: string, days: number) => ({ ok: true, value: { days, changes: ['Shipped: guest checkout'] } }),
    issues: async () => ({ ok: true, value: { issues: ['Waiting for the owner to approve: dark header'] } }),
    ...over,
  } as unknown as CompanionApi;
}

/** The repo a directory belongs to, without a real repository behind it. */
const REPOS: Record<string, string> = { '/home/me/loom': 'acme/loom' };

async function connect(api: CompanionApi, cwd = '/home/me/loom') {
  const server = buildContextServer(api, () => cwd, async (dir) => REPOS[dir] ?? null);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: unknown) => ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

describe('the selvedge-context MCP server', () => {
  it('offers exactly three tools, all of them read-only', async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_open_issues', 'get_project_context', 'get_recent_changes']);
    // Nothing here writes: an agent that could edit the pack could store its
    // own assumptions in the one place that is supposed to hold what happened.
    expect(tools.some((t) => /write|set|update|add/i.test(t.name))).toBe(false);
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('serves the project it is sitting in, resolved from the repo', async () => {
    const client = await connect(fakeApi());
    const result = await client.callTool({ name: 'get_project_context', arguments: {} });
    expect(textOf(result)).toContain('Loom — a curtain shop');
  });

  it('says which projects exist when it cannot tell where it is', async () => {
    const client = await connect(fakeApi(), '/somewhere/unknown');
    const result = await client.callTool({ name: 'get_project_context', arguments: {} });
    const said = textOf(result);
    expect(said).toMatch(/can't tell which project/i);
    expect(said).toContain('loom');
    expect(said).toContain('ravel');
  });

  it('takes an explicit project, and refuses one it does not have', async () => {
    const client = await connect(fakeApi(), '/somewhere/unknown');
    expect(textOf(await client.callTool({ name: 'get_project_context', arguments: { project: 'ravel' } }))).toContain('WHAT THIS IS');
    expect(textOf(await client.callTool({ name: 'get_project_context', arguments: { project: 'nope' } }))).toMatch(/don't have a project called/i);
  });

  it('answers what changed, and says plainly when it saw nothing', async () => {
    const client = await connect(fakeApi());
    expect(textOf(await client.callTool({ name: 'get_recent_changes', arguments: { days: 7 } }))).toContain('Shipped: guest checkout');

    const quiet = await connect(fakeApi({ changes: async () => ({ ok: true, value: { days: 14, changes: [] } }) }));
    const said = textOf(await quiet.callTool({ name: 'get_recent_changes', arguments: {} }));
    // The distinction the whole product rests on: nothing seen is not nothing happened.
    expect(said).toMatch(/saw nothing/i);
    expect(said).toMatch(/not that nothing happened/i);
  });

  it('answers what is open', async () => {
    const client = await connect(fakeApi());
    expect(textOf(await client.callTool({ name: 'get_open_issues', arguments: {} }))).toContain('Waiting for the owner');
  });

  it('says so when Selvedge is unreachable, instead of answering from nothing', async () => {
    const client = await connect(fakeApi({ projects: async () => ({ ok: false, error: 'offline' }) }));
    expect(textOf(await client.callTool({ name: 'get_project_context', arguments: {} }))).toMatch(/couldn't reach Selvedge/i);
  });

  it('resolves a project by id, by name, or not at all', async () => {
    const api = fakeApi();
    expect(await resolveProject(api, 'loom', '/x', async () => null)).toMatchObject({ ok: true, projectId: 'loom' });
    expect(await resolveProject(api, 'Ravel', '/x', async () => null)).toMatchObject({ ok: true, projectId: 'ravel' });
    expect(await resolveProject(api, undefined, '/x', async () => 'acme/ravel')).toMatchObject({ ok: true, projectId: 'ravel' });
    expect(await resolveProject(api, undefined, '/x', async () => 'someone/else')).toMatchObject({ ok: false });
  });
});
