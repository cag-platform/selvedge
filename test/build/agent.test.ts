import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentRuns } from '../../src/server/db/schema/index.js';
import { runAgentTurn, type ExecuteInSandbox } from '../../src/server/build/agent.js';
import { getBuild, setBuild } from '../../src/server/build/store.js';

const cfg = { claudeCodeOauthToken: 't', githubToken: 'g', repoFullName: 'acme/loom', branch: 'main' };

const successStream = (sessionId: string, text: string, cost = 0.05) =>
  [
    `{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}`,
    `{"type":"result","subtype":"success","total_cost_usd":${cost},"session_id":"${sessionId}","is_error":false}`,
  ].join('\n');

/** A scripted executor: claude commands get the scripted stream; git status gets the scripted staged output. */
function executor(opts: { stream?: string; exitCode?: number; staged?: boolean; onCommand?: (c: string) => void }): ExecuteInSandbox {
  return async (command: string) => {
    opts.onCommand?.(command);
    if (command.includes('git status')) return { exitCode: 0, result: opts.staged ? ' M src/app.ts' : '' };
    return { exitCode: opts.exitCode ?? 0, result: opts.stream ?? '' };
  };
}

describe('runAgentTurn — a plain-English ask becomes a recorded, costed turn', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('happy path: thread has both messages, the run has its real cost, session + staged flag saved', async () => {
    const out = await runAgentTurn(db, orgId, 'loom', 'make the header dark', cfg, {
      execute: executor({ stream: successStream('sess_1', 'I made the header dark.'), staged: true }),
    });

    expect(out.status).toBe('succeeded');
    expect(out.costCents).toBe(5);
    expect(out.reply).toBe('I made the header dark.');
    expect(out.stagedChangesReady).toBe(true);

    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(thread.map((m) => m.role)).toEqual(['owner', 'agent']);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.status).toBe('succeeded');
    expect(run!.costCents).toBe(5);

    const build = await getBuild(db, orgId, 'loom');
    expect(build?.claudeSessionId).toBe('sess_1'); // the next turn resumes this
    expect(build?.stagedChangesReady).toBe(true);
  });

  it('the second turn resumes the saved session — iteration, not starting over', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_1' });
    const commands: string[] = [];
    await runAgentTurn(db, orgId, 'loom', 'now darker', cfg, {
      execute: executor({ stream: successStream('sess_2', 'Darker now.'), onCommand: (c) => commands.push(c) }),
    });
    expect(commands[0]).toContain("--resume 'sess_1'");
    expect((await getBuild(db, orgId, 'loom'))?.claudeSessionId).toBe('sess_2');
  });

  it('a stale session retries once fresh instead of failing the turn', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_dead' });
    const commands: string[] = [];
    let call = 0;
    const execute: ExecuteInSandbox = async (command) => {
      commands.push(command);
      if (command.includes('git status')) return { exitCode: 0, result: '' };
      call += 1;
      if (call === 1) return { exitCode: 1, result: 'No conversation found' }; // stale --resume
      return { exitCode: 0, result: successStream('sess_new', 'Fresh start, done.') };
    };
    const out = await runAgentTurn(db, orgId, 'loom', 'try again', cfg, { execute });
    expect(out.status).toBe('succeeded');
    expect(commands[0]).toContain('--resume');
    expect(commands[1]).not.toContain('--resume');
  });

  it('a failed turn is honest on the thread and recorded as failed — never a silent shrug', async () => {
    const out = await runAgentTurn(db, orgId, 'loom', 'do the thing', cfg, {
      execute: executor({ exitCode: 1, stream: '' }),
    });
    expect(out.status).toBe('failed');
    expect(out.reply).toMatch(/couldn't finish/i);
    expect(out.stagedChangesReady).toBe(false);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.status).toBe('failed');
  });
});
