import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createCompanionRouter } from '../../src/server/web/routes/companion.js';
import { issueCompanionToken } from '../../src/server/companion/tokens.js';
import { listExternalSessions } from '../../src/server/companion/sessions.js';
import { projectTimeline } from '../../src/server/timeline/store.js';
import { externalSessionLinesForWindow } from '../../src/server/digest/sessions.js';
import { listPacks } from '../../src/server/packs/store.js';
import { CompanionApi } from '../../src/cli/api.js';
import { watchOnce } from '../../src/cli/watch.js';
import { buildContextServer } from '../../src/cli/mcp.js';

/**
 * THE LOOP, END TO END — as close to the phase's gate as a test can get.
 *
 * A day's work happens in a terminal: a session log is written on a machine,
 * the companion reads it, and a summary goes over real HTTP to the real ingest
 * route. Then the two things that have to be true the next morning: the work is
 * on the project's history and in the brief's words, and an agent mounting the
 * MCP server is told what this project is — without anyone having explained it.
 *
 * What a test can't do is spend the day. The gate itself is still a person, a
 * terminal, and a morning.
 */
describe('the loop: a terminal session, and an agent that knows about it', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let server: Server;
  let baseUrl: string;
  let home: string;
  let token: string;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    await createPack(
      db,
      'org_1',
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A made-to-measure curtain shop.' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true, downtime_translation: 'Nobody can order curtains.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    token = (await issueCompanionToken(db, 'org_1', 'the laptop')).token;

    const app = express();
    app.use(express.json());
    app.use(createCompanionRouter(db));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    home = mkdtempSync(path.join(tmpdir(), 'selvedge-loop-'));
    mkdirSync(path.join(home, '.claude', 'projects', 'loom'), { recursive: true });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    await close();
  });

  function aSessionHappened() {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-morning.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-morning',
          cwd: '/home/me/loom',
          timestamp: '2026-08-20T09:00:00Z',
          message: { content: 'make the checkout one page instead of three' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-morning',
          costUSD: 0.31,
          timestamp: '2026-08-20T10:30:00Z',
          message: {
            content: [
              { type: 'text', text: 'I moved the three steps into one page.' },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/home/me/loom/src/checkout/Cart.tsx' } },
              { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        }),
      ].join('\n'),
    );
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    return file;
  }

  const api = () => new CompanionApi({ api: baseUrl, token }, fetch);

  it('carries a terminal session into the record, marked as observed, without carrying the work itself', async () => {
    aSessionHappened();

    const result = await watchOnce({
      api: api(),
      roots: { claude: path.join(home, '.claude', 'projects') },
      statePath: path.join(home, 'state.json'),
      repoFor: async () => 'acme/loom',
      commitDuring: async () => 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    });
    expect(result.sent).toBe(1);

    // It landed, on the right project, as a summary.
    const [stored] = await listExternalSessions(db, 'org_1');
    expect(stored).toMatchObject({
      projectId: 'loom',
      agent: 'claude-code',
      sessionId: 'sess-morning',
      outcome: 'shipped',
      intent: 'make the checkout one page instead of three',
    });
    expect(stored!.filesTouched).toEqual(['src/checkout/Cart.tsx']);
    // The conversation stayed on the machine it happened on.
    expect(JSON.stringify(stored)).not.toContain('I moved the three steps');

    // It is on the project's history, and it says whose work it was.
    const timeline = await projectTimeline(db, 'org_1', 'loom');
    const session = timeline.find((e) => e.kind === 'session');
    expect(session?.sentence).toContain('outside Selvedge');
    expect(session?.sentence).toContain('make the checkout one page');
    expect(session?.evidence.join(' ')).toMatch(/did not run this work, did not gate it/);
    expect(session?.status).not.toBe('healthy'); // observed work is never reported as verified

    // And tomorrow's brief has the sentence.
    const packs = await listPacks(db, 'org_1');
    const lines = await externalSessionLinesForWindow(db, 'org_1', new Date(Date.now() - 86_400_000), new Date(Date.now() + 60_000), packs);
    expect(lines[0]).toContain('Yesterday, outside Selvedge:');
    expect(lines[0]).toContain('on Loom');
    expect(lines[0]).toContain('shipped');
  });

  it('reports a session it could not read, all the way through to the brief', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-broken.jsonl');
    writeFileSync(file, 'garbage that is not a session log');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);

    await watchOnce({
      api: api(),
      roots: { claude: path.join(home, '.claude', 'projects') },
      statePath: path.join(home, 'state.json'),
      repoFor: async () => null,
      commitDuring: async () => null,
    });

    const packs = await listPacks(db, 'org_1');
    const lines = await externalSessionLinesForWindow(db, 'org_1', new Date(Date.now() - 86_400_000), new Date(Date.now() + 60_000), packs);
    expect(lines[0]).toMatch(/^I couldn't read/);
  });

  it('hands the project\'s context to an agent that mounts the MCP server, with nothing re-explained', async () => {
    aSessionHappened();
    await watchOnce({
      api: api(),
      roots: { claude: path.join(home, '.claude', 'projects') },
      statePath: path.join(home, 'state.json'),
      repoFor: async () => 'acme/loom',
      commitDuring: async () => null,
    });

    // A fresh agent, in the repo, knowing only its own directory.
    const mcp = buildContextServer(api(), () => '/home/me/loom', async () => 'acme/loom');
    const client = new Client({ name: 'a fresh agent', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);

    const said = (result: unknown) => ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

    const context = said(await client.callTool({ name: 'get_project_context', arguments: {} }));
    expect(context).toContain('Loom');
    expect(context).toContain('made-to-measure curtain shop');
    expect(context).toMatch(/it handles money/i);
    expect(context).toContain('Nobody can order curtains');

    const changes = said(await client.callTool({ name: 'get_recent_changes', arguments: {} }));
    // The session it just heard about is there — and marked as merely observed.
    expect(changes).toContain('make the checkout one page');
    expect(changes).toContain('Observed from outside');
  });
});
