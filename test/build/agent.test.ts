import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentMessageAttachments, agentRuns } from '../../src/server/db/schema/index.js';
import { runAgentTurn, type ExecuteInSandbox, type UploadToSandbox } from '../../src/server/build/agent.js';
import { getBuild, setBuild } from '../../src/server/build/store.js';
import { createThread, ensureWorkshopThread, listThreads } from '../../src/server/threads/store.js';

const cfg = { githubToken: 'g', repoFullName: 'acme/loom', branch: 'main' };

/**
 * These tests are about the TURN LOOP — poll, stream, record, price, resume —
 * not about whose account pays for it. So they run on the managed path: the
 * deployment's own credentials, which is one of the two real configurations.
 * Which account a turn resolves to, and why it is the org's before the
 * platform's, is held by test/build/builderAuth.test.ts.
 *
 * Set explicitly because test/setup.ts strips every ambient credential — a
 * suite that reads the developer's shell is a suite that goes red on somebody
 * else's machine, which is how CI spent a day red before that file existed.
 */
function managedFuel() {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'platform-claude-token';
  process.env.OPENAI_API_KEY = 'sk-platform';
}
function noFuel() {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.OPENAI_API_KEY;
}

const toolUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const text = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const resultLine = (sessionId: string, cost = 0.05) =>
  JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: cost, session_id: sessionId, is_error: false });

/**
 * A scripted executor for the streaming shape: the start command is a no-op,
 * each poll returns the next scripted log snapshot (the last one marked DONE),
 * and git status returns the scripted staged state.
 */
function executor(opts: { polls: string[]; staged?: boolean; onCommand?: (c: string) => void }): ExecuteInSandbox {
  let poll = 0;
  return async (command: string) => {
    opts.onCommand?.(command);
    if (command.includes('git status')) return { exitCode: 0, result: opts.staged ? ' M src/app.ts' : '' };
    if (command.includes('git diff --name-only')) return { exitCode: 0, result: opts.staged ? 'src/app.ts\n' : '' };
    if (command.includes('__STATE:')) {
      const i = Math.min(poll, opts.polls.length - 1);
      poll += 1;
      const last = i === opts.polls.length - 1;
      return { exitCode: 0, result: `${opts.polls[i]}\n__STATE:${last ? 'DONE' : 'ALIVE'}` };
    }
    return { exitCode: 0, result: '' }; // start / kill / misc
  };
}

const noSleep = async () => {};

describe('runAgentTurn — streamed, costed, resumable', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    managedFuel();
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    noFuel();
    await close();
  });

  it('streams activity onto the thread WHILE working, then lands the reply, cost, session, staged flag', async () => {
    const step1 = [toolUse('Read', { file_path: '/workspace/app/src/App.tsx' })].join('\n');
    const step2 = [step1, toolUse('Edit', { file_path: '/workspace/app/src/App.tsx' }), toolUse('Bash', { command: 'npm test' })].join('\n');
    const done = [step2, text('I made the header dark.'), resultLine('sess_1'), '__EXIT:0'].join('\n');

    // Snapshot the activity row mid-flight via the sleep hook.
    const activitySnapshots: string[] = [];
    const sleep = async () => {
      const rows = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'activity')));
      if (rows[0]) activitySnapshots.push(rows[0].content);
    };

    const out = await runAgentTurn(db, orgId, 'loom', 'make the header dark', cfg, {}, {
      execute: executor({ polls: [step1, step2, done], staged: true }),
      sleep,
    });

    expect(out.status).toBe('succeeded');
    expect(out.costCents).toBe(5);
    expect(out.reply).toBe('I made the header dark.');
    expect(out.stagedChangesReady).toBe(true);
    const ownedBuild = await getBuild(db, orgId, 'loom');
    expect(ownedBuild).toMatchObject({ dirtyRunId: out.runId, dirtyThreadId: expect.any(String), dirtyAgent: 'claude-code' });
    expect(ownedBuild?.dirtyObservedAt).toBeInstanceOf(Date);

    // The live feed existed BEFORE the turn finished, and reads like work.
    expect(activitySnapshots.some((s) => s.includes('Reading src/App.tsx'))).toBe(true);
    const final = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'activity')));
    expect(final[0]!.content).toContain('Editing src/App.tsx');
    expect(final[0]!.content).toContain('Running: npm test');

    const thread = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(thread.map((m) => m.role)).toEqual(['owner', 'activity', 'agent']);

    // The flight recorder: every thread row joined to the run, and the
    // activity row's meta carrying the full structured record.
    expect(thread.every((m) => m.runId === out.runId)).toBe(true);
    const record = thread.find((m) => m.role === 'activity')!.meta as { run_id: string; tools: Array<{ name: string }>; truncated: boolean };
    expect(record.run_id).toBe(out.runId);
    expect(record.truncated).toBe(false);
    expect(record.tools.map((t) => t.name)).toEqual(['Read', 'Edit', 'Bash']);

    // The files the turn touched land on the run row — the change is traceable.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(run!.changedPaths).toEqual(['src/app.ts']);
    expect((await getBuild(db, orgId, 'loom'))?.claudeSessionId).toBe('sess_1');
  });

  it('the second turn resumes the saved session — iteration, not starting over', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_1' });
    const commands: string[] = [];
    await runAgentTurn(db, orgId, 'loom', 'now darker', cfg, {}, {
      execute: executor({ polls: [[text('Darker.'), resultLine('sess_2'), '__EXIT:0'].join('\n')], onCommand: (c) => commands.push(c) }),
      sleep: noSleep,
    });
    // The inner command rides through the outer nohup quoting, so assert parts.
    expect(commands[0]).toContain('--resume');
    expect(commands[0]).toContain('sess_1');
    expect((await getBuild(db, orgId, 'loom'))?.claudeSessionId).toBe('sess_2');
  });

  it('a stale session retries once fresh instead of failing the turn', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_dead' });
    const starts: string[] = [];
    let phase = 0; // 0: first attempt polls fail; 1: fresh attempt succeeds
    const execute: ExecuteInSandbox = async (command) => {
      if (command.includes('nohup')) {
        starts.push(command);
        phase = starts.length;
        return { exitCode: 0, result: '' };
      }
      if (command.includes('git status')) return { exitCode: 0, result: '' };
      if (command.includes('__STATE:')) {
        const body = phase === 1 ? 'No conversation found\n__EXIT:1' : [text('Fresh, done.'), resultLine('sess_new'), '__EXIT:0'].join('\n');
        return { exitCode: 0, result: `${body}\n__STATE:DONE` };
      }
      return { exitCode: 0, result: '' };
    };
    const out = await runAgentTurn(db, orgId, 'loom', 'try again', cfg, {}, { execute, sleep: noSleep });
    expect(out.status).toBe('succeeded');
    expect(starts[0]).toContain('--resume');
    expect(starts[1]).not.toContain('--resume');
  });

  it('a retried turn reports the cost of BOTH attempts — the failed one spent real money too', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_dead' });
    const starts: string[] = [];
    let phase = 0;
    const execute: ExecuteInSandbox = async (command) => {
      if (command.includes('nohup')) {
        starts.push(command);
        phase = starts.length;
        return { exitCode: 0, result: '' };
      }
      if (command.includes('git status')) return { exitCode: 0, result: '' };
      if (command.includes('__STATE:')) {
        // Attempt 1 did work (7¢ of it) before the resume died; attempt 2 costs 5¢.
        const body =
          phase === 1
            ? [toolUse('Read', { file_path: '/workspace/app/a.ts' }), resultLine('sess_dead', 0.07), '__EXIT:1'].join('\n')
            : [text('Fresh, done.'), resultLine('sess_new', 0.05), '__EXIT:0'].join('\n');
        return { exitCode: 0, result: `${body}\n__STATE:DONE` };
      }
      return { exitCode: 0, result: '' };
    };
    const out = await runAgentTurn(db, orgId, 'loom', 'try again', cfg, {}, { execute, sleep: noSleep });
    expect(out.status).toBe('succeeded');
    expect(out.costCents).toBe(12); // 7 + 5, not 5
  });

  it('the activity feed appends across a retry — never stalls, never rewinds', async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'sess_dead' });
    let phase = 0;
    const execute: ExecuteInSandbox = async (command) => {
      if (command.includes('nohup')) {
        phase += 1;
        return { exitCode: 0, result: '' };
      }
      if (command.includes('git status')) return { exitCode: 0, result: '' };
      if (command.includes('__STATE:')) {
        // Attempt 1 shows three tool lines then dies; attempt 2's fresh log has
        // only ONE line — fewer than already shown, the exact rewind case.
        const body =
          phase === 1
            ? [
                toolUse('Read', { file_path: '/workspace/app/a.ts' }),
                toolUse('Read', { file_path: '/workspace/app/b.ts' }),
                toolUse('Read', { file_path: '/workspace/app/c.ts' }),
                '__EXIT:1',
              ].join('\n')
            : [toolUse('Edit', { file_path: '/workspace/app/d.ts' }), text('Done.'), resultLine('sess_new'), '__EXIT:0'].join('\n');
        return { exitCode: 0, result: `${body}\n__STATE:DONE` };
      }
      return { exitCode: 0, result: '' };
    };
    const out = await runAgentTurn(db, orgId, 'loom', 'try again', cfg, {}, { execute, sleep: noSleep });
    expect(out.status).toBe('succeeded');

    const rows = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'activity')));
    expect(rows).toHaveLength(1); // one feed, not one per attempt
    // Attempt 1's work is still there, attempt 2's follows it — appended, not replaced.
    expect(rows[0]!.content).toContain('Reading c.ts');
    expect(rows[0]!.content).toContain('Editing d.ts');
    expect(rows[0]!.content.indexOf('Reading c.ts')).toBeLessThan(rows[0]!.content.indexOf('Editing d.ts'));
  });

  it('a failed turn is honest on the thread and recorded as failed — never a silent shrug', async () => {
    const out = await runAgentTurn(db, orgId, 'loom', 'do the thing', cfg, {}, {
      execute: executor({ polls: ['boom\n__EXIT:1'] }),
      sleep: noSleep,
    });
    expect(out.status).toBe('failed');
    // The agent's own words, not a shrug: "boom" is what the CLI said, and it
    // is the only thing anybody can act on.
    expect(out.reply).toContain('boom');
    expect(out.reply).toMatch(/[Nn]othing was shipped/);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.status).toBe('failed');
  });

  it('a turn that runs past the ceiling is stopped and says so plainly', async () => {
    let clock = 0;
    const neverDone: ExecuteInSandbox = async (command) => {
      if (command.includes('__STATE:')) return { exitCode: 0, result: 'still going\n__STATE:ALIVE' };
      if (command.includes('git status')) return { exitCode: 0, result: '' };
      return { exitCode: 0, result: '' };
    };
    const out = await runAgentTurn(db, orgId, 'loom', 'endless task', cfg, {}, {
      execute: neverDone,
      sleep: noSleep,
      now: () => (clock += 16 * 60 * 1000), // two ticks blow past the 30-min ceiling
    });
    expect(out.status).toBe('failed');
    expect(out.reply).toMatch(/took too long/i);
  });

  it('writes attached screenshots and files into the sandbox, notes them in the CLI prompt, and stores the images for the thread', async () => {
    const uploads: Array<{ path: string; bytes: number }> = [];
    const commands: string[] = [];
    const uploadFile: UploadToSandbox = async (absPath, data) => {
      uploads.push({ path: absPath, bytes: data.length });
    };
    const out = await runAgentTurn(
      db,
      orgId,
      'loom',
      'match this mockup and use the sample data',
      cfg,
      {
        images: [{ mime: 'image/png', dataBase64: Buffer.from('fake-png').toString('base64') }],
        files: [{ name: 'sample.csv', dataBase64: Buffer.from('a,b\n1,2').toString('base64') }],
      },
      {
        execute: executor({ polls: [[text('Done.'), resultLine('sess_a'), '__EXIT:0'].join('\n')], onCommand: (c) => commands.push(c) }),
        uploadFile,
        sleep: noSleep,
      },
    );
    expect(out.status).toBe('succeeded');

    // The screenshot landed outside the project (never lands in the app or a ship).
    expect(uploads.some((u) => u.path.startsWith('/workspace/.selvedge/uploads/') && u.path.endsWith('.png'))).toBe(true);
    // The plain file landed at the project root under its own name.
    expect(uploads.some((u) => u.path === '/workspace/project/sample.csv')).toBe(true);

    // The CLI prompt (what the nohup command actually ran) points the agent at both.
    const startCmd = commands.find((c) => c.includes('nohup'))!;
    expect(startCmd).toContain('.selvedge/uploads');
    expect(startCmd).toContain('sample.csv');
    expect(startCmd).toContain('do not commit, push, merge, deploy, publish, or force-push');

    // The image is persisted for the thread; the CSV is not (transient input only).
    const owner = (await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'owner'))))[0]!;
    const atts = await db.select().from(agentMessageAttachments).where(eq(agentMessageAttachments.agentMessageId, owner.id));
    expect(atts).toHaveLength(1);
    expect(atts[0]!.mime).toBe('image/png');
  });

  it('plan mode thinks it through without touching anything — no staging, no ship, framed as a plan', async () => {
    const commands: string[] = [];
    const out = await runAgentTurn(
      db,
      orgId,
      'loom',
      'a review queue for the plant library',
      cfg,
      { mode: 'plan' },
      {
        // staged: true — even if the sandbox reported dirty files, a plan turn
        // must not mark work ready to ship.
        execute: executor({ polls: [[text('Here is the plan: 1. …'), resultLine('sess_p'), '__EXIT:0'].join('\n')], staged: true, onCommand: (c) => commands.push(c) }),
        sleep: noSleep,
      },
    );
    expect(out.status).toBe('succeeded');
    expect(out.stagedChangesReady).toBe(false);
    expect(out.reply).toContain('Here is the plan');

    // The agent was told, in the prompt itself, not to change anything.
    const startCmd = commands.find((c) => c.includes('nohup'))!;
    expect(startCmd).toContain('Do NOT create, edit, move, or delete any files');
    // And it never even asked git what changed.
    expect(commands.some((c) => c.includes('git status'))).toBe(false);

    // The run is tagged as a plan, so the workshop can tell thinking from building.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.prompt.startsWith('plan:')).toBe(true);
  });

  it('a plan turn never clears a real staged change that was already waiting to ship', async () => {
    await setBuild(db, orgId, 'loom', { stagedChangesReady: true });
    const out = await runAgentTurn(db, orgId, 'loom', 'what about a dark mode?', cfg, { mode: 'plan' }, {
      execute: executor({ polls: [[text('Plan…'), resultLine('sess_q'), '__EXIT:0'].join('\n')] }),
      sleep: noSleep,
    });
    expect(out.stagedChangesReady).toBe(true);
    expect((await getBuild(db, orgId, 'loom'))?.stagedChangesReady).toBe(true);
  });

  it('a bad attachment does not sink the turn — it is noted and the rest proceeds', async () => {
    const uploadFile: UploadToSandbox = async (absPath) => {
      if (absPath.endsWith('.zip')) throw new Error('disk full');
    };
    const out = await runAgentTurn(
      db,
      orgId,
      'loom',
      'import my old app',
      cfg,
      { files: [{ name: 'old-app.zip', mime: 'application/zip', dataBase64: Buffer.from('pk').toString('base64') }] },
      { execute: executor({ polls: [[text('Done.'), resultLine('sess_b'), '__EXIT:0'].join('\n')] }), uploadFile, sleep: noSleep },
    );
    expect(out.status).toBe('succeeded');
  });
});


/**
 * A turn writes four rows — the owner's message, the live activity row, the
 * reply, and the run. All four belong to ONE conversation; a row that lands
 * without a thread is a row that will never be read again once a project holds
 * more than one.
 */
describe('runAgentTurn — every row lands in one conversation', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const done = [text('Done.'), resultLine('sess_1'), '__EXIT:0'].join('\n');

  beforeEach(async () => {
    managedFuel();
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    noFuel();
    await close();
  });

  it('opens the project workshop thread on the first turn and writes everything into it', async () => {
    await runAgentTurn(db, orgId, 'loom', 'make the header dark', cfg, {}, {
      execute: executor({ polls: [done], staged: true }),
      sleep: noSleep,
    });

    const threads = await listThreads(db, orgId, 'loom');
    expect(threads).toHaveLength(1);
    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every((m) => m.threadId === threads[0]!.id)).toBe(true);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.threadId).toBe(threads[0]!.id);
  });

  it('a second turn continues the same conversation rather than opening another', async () => {
    const run = () =>
      runAgentTurn(db, orgId, 'loom', 'again', cfg, {}, { execute: executor({ polls: [done] }), sleep: noSleep });
    await run();
    await run();
    expect(await listThreads(db, orgId, 'loom')).toHaveLength(1);
  });

  it('writes into the thread it was given, when it was given one', async () => {
    const workshop = await ensureWorkshopThread(db, orgId, 'loom');
    const other = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'A second piece of work' });
    await runAgentTurn(db, orgId, 'loom', 'in that thread please', cfg, { threadId: other.id }, {
      execute: executor({ polls: [done] }),
      sleep: noSleep,
    });

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(messages.every((m) => m.threadId === other.id)).toBe(true);
    // ...and the project's first conversation is untouched by it.
    expect(workshop.id).not.toBe(other.id);
    expect(messages.some((m) => m.threadId === workshop.id)).toBe(false);
  });
});


/**
 * THE SECOND BUILDER. Same sandbox, same checkout, same thread — a different
 * CLI. The orchestration (poll, stream, record, price, resume) is shared by
 * construction; what these tests hold is that the agent-specific half is
 * actually used, that the two builders never inherit each other's session, and
 * that an agent this deployment has no fuel for says so instead of silently
 * becoming the other one.
 */
describe('runAgentTurn — building with Codex', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const codexCfg = { ...cfg, agent: 'codex' as const };

  const codexLog = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_9' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I made the header dark.' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 300 } }),
    '__EXIT:0',
  ].join('\n');

  beforeEach(async () => {
    managedFuel();
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    noFuel();
    await close();
  });

  it('runs the Codex CLI, records who did the work, and prices the turn from its tokens', async () => {
    const commands: string[] = [];
    const out = await runAgentTurn(db, orgId, 'loom', 'make the header dark', codexCfg, {}, {
      execute: executor({ polls: [codexLog], staged: true, onCommand: (c) => commands.push(c) }),
      sleep: noSleep,
    });

    expect(out.status).toBe('succeeded');
    expect(out.agent).toBe('codex');
    expect(out.reply).toContain('I made the header dark.');
    expect(commands.some((c) => c.includes('codex exec'))).toBe(true);
    expect(commands.some((c) => c.includes('@openai/codex'))).toBe(true); // installs itself if the image lacks it
    expect(commands.some((c) => c.includes('claude -p'))).toBe(false);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.agent).toBe('codex');
    // 1200 in + 300 out on the priced model, in whole cents.
    expect(run!.costCents).toBe(1);
  });

  it("keeps the two builders' sessions apart inside the one sandbox", async () => {
    await setBuild(db, orgId, 'loom', { claudeSessionId: 'claude_sess' });
    await runAgentTurn(db, orgId, 'loom', 'again', codexCfg, {}, { execute: executor({ polls: [codexLog] }), sleep: noSleep });

    const build = await getBuild(db, orgId, 'loom');
    expect(build!.codexSessionId).toBe('th_9');
    // Claude's session is untouched: switching back must not resume the wrong conversation.
    expect(build!.claudeSessionId).toBe('claude_sess');
  });

  it('starts the turn with the handover when the thread just changed hands', async () => {
    const commands: string[] = [];
    await runAgentTurn(
      db,
      orgId,
      'loom',
      'now finish the checkout',
      codexCfg,
      { handoff: 'THE PROJECT\n- Loom — a curtain shop.' },
      { execute: executor({ polls: [codexLog], onCommand: (c) => commands.push(c) }), sleep: noSleep },
    );
    const start = commands.find((c) => c.includes('codex exec'))!;
    expect(start).toContain('Loom — a curtain shop.');
    expect(start).toContain('now finish the checkout');
  });

  it('an agent with no account to run on is refused in plain words, not silently swapped', async () => {
    // No key anywhere: not on the org, and not on the deployment either.
    delete process.env.OPENAI_API_KEY;
    const commands: string[] = [];
    const out = await runAgentTurn(db, orgId, 'loom', 'make the header dark', { ...cfg, agent: 'codex' }, {}, {
      execute: executor({ polls: [codexLog], onCommand: (c) => commands.push(c) }),
      sleep: noSleep,
    });

    expect(out.status).toBe('failed');
    // The resolver's own sentence, which names the credential AND the screen —
    // and, because Codex is not the only builder, the way back to the other one.
    expect(out.reply).toMatch(/OpenAI API key/i);
    expect(out.reply).toMatch(/Connections/);
    expect(out.reply).toMatch(/switch this thread to Claude Code/i);
    expect(commands).toHaveLength(0); // nothing ran, nothing was spent
    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    // The owner's message is still on the record, with the honest answer under it.
    expect(messages.map((m) => m.role)).toEqual(['owner', 'agent']);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run!.status).toBe('failed');
  });

  it('says so when Codex reports no usage, instead of showing a free turn', async () => {
    const noUsage = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }),
      JSON.stringify({ type: 'turn.completed' }),
      '__EXIT:0',
    ].join('\n');
    const out = await runAgentTurn(db, orgId, 'loom', 'x', codexCfg, {}, { execute: executor({ polls: [noUsage] }), sleep: noSleep });
    expect(out.status).toBe('succeeded');
    expect(out.costCents).toBe(0);
    expect(out.reply).toMatch(/didn't report what that turn cost/i);
  });
});
