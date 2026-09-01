import { describe, it, expect } from 'vitest';
import {
  codexCommand,
  codexInstallCommand,
  parseCodexActivity,
  parseCodexEvents,
  parseCodexResult,
  parseCodexText,
} from '../../src/server/runner/workers/codexCommand.js';
import { startCommand } from '../../src/server/build/agent.js';

/**
 * The second builder's CLI has an undocumented event stream that has changed
 * shape between versions, so these tests pin the two things that matter: the
 * command we run, and that the parsers read the shapes seen in the wild while
 * refusing to guess at anything else. The load-bearing case is the last one —
 * a stream we can't read must fail the turn, never pass it.
 */
const line = (o: unknown) => JSON.stringify(o);

describe('the Codex command', () => {
  it('runs one turn in the project, with the key in the environment rather than the repo', () => {
    const cmd = codexCommand('make the header dark', { apiKey: 'sk-test', model: 'gpt-5.6-terra' });
    expect(cmd).toContain('cd /workspace/project');
    expect(cmd).not.toContain('OPENAI_API_KEY=');
    expect(cmd).not.toContain('sk-test');
    expect(cmd).toContain('codex exec');
    expect(cmd).toContain('--json');
    expect(cmd).toContain("--model 'gpt-5.6-terra'");
    expect(cmd).toContain('codex login --with-api-key');
    expect(cmd).toContain('CODEX_HOME=/tmp/selvedge-codex-home');
    expect(cmd).toContain('rm -f /tmp/selvedge-codex-prompt /tmp/selvedge-codex-home/auth.json');
  });

  it('carries the standing rules in the prompt, because this CLI has no system-prompt flag', () => {
    const cmd = codexCommand('make the header dark', { apiKey: 'k' });
    // The rules must reach the agent somehow, and the one way they must NOT is
    // a file in the customer's repository.
    const encoded = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/selvedge-codex-prompt/.exec(cmd)?.[1];
    expect(encoded).toBeTruthy();
    const transported = Buffer.from(encoded!, 'base64').toString('utf8');
    expect(transported).toContain('no terminal');
    expect(transported).toContain('make the header dark');
    expect(cmd).not.toContain('AGENTS.md');
  });

  it('a thinking turn runs read-only; a building turn is allowed to work', () => {
    expect(codexCommand('x', { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' }, mode: 'plan' })).toContain('--sandbox read-only');
    expect(codexCommand('x', { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' }, mode: 'build' })).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(codexCommand('x', { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' }, mode: 'plan' })).not.toContain('bypass-approvals');
  });

  it('resumes its own session when it has one, and installs itself if the image lacks it', () => {
    expect(codexCommand('x', { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' }, resumeSessionId: 'sess_9' })).toContain("resume 'sess_9'");
    expect(codexCommand('x', { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' } })).not.toContain('resume');
    expect(codexInstallCommand()).toContain('@openai/codex');
  });

  it('quotes a prompt that would otherwise escape the shell', () => {
    const cmd = codexCommand("it's broken; rm -rf /", { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' } });
    expect(cmd).not.toContain("it's broken");
    expect(cmd).toContain('base64 -d');
    expect(cmd).toContain('codex exec');
    expect(cmd).toContain(' - < /tmp/selvedge-codex-prompt');
  });

  it('keeps the complete prompt as data through the detached launcher', () => {
    const prompt = "owner's app (build it)\n- Anything secret stays in environment\n`touch /tmp/never`";
    const inner = codexCommand(prompt, { auth: { envVar: 'OPENAI_API_KEY', secret: 'k' } });
    const detached = startCommand(inner, '/tmp/turn.log', '/tmp/turn.pid');
    expect(detached).not.toContain(prompt);
    expect(detached).not.toContain("owner's app");

    const encodedScript = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(detached)?.[1];
    expect(encodedScript).toBeTruthy();
    const decodedScript = Buffer.from(encodedScript!, 'base64').toString('utf8');
    expect(decodedScript).toContain('codex exec');
    expect(decodedScript).not.toContain(prompt);

    const encodedPrompt = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/selvedge-codex-prompt/.exec(decodedScript)?.[1];
    expect(encodedPrompt).toBeTruthy();
    expect(Buffer.from(encodedPrompt!, 'base64').toString('utf8')).toContain(prompt);
  });
});

describe('reading a Codex turn', () => {
  const modern = [
    line({ type: 'thread.started', thread_id: 'th_1' }),
    line({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } }),
    line({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/workspace/app/src/App.tsx' }], success: true } }),
    line({ type: 'item.completed', item: { type: 'agent_message', text: 'I made the header dark.' } }),
    line({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 300 } }),
  ].join('\n');

  const older = [
    line({ msg: { type: 'session_configured', session_id: 'sess_7' } }),
    line({ msg: { type: 'exec_command_begin', command: ['npm', 'test'] } }),
    line({ msg: { type: 'exec_command_end', command: ['npm', 'test'], exit_code: 1, aggregated_output: 'FAIL src/app.test.ts' } }),
    line({ msg: { type: 'agent_message', message: 'The test is failing.' } }),
    line({ msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, output_tokens: 100 } } } }),
    line({ type: 'turn.completed' }),
  ].join('\n');

  it('reads the session, the outcome and the usage out of the current shape', () => {
    const result = parseCodexResult(modern);
    expect(result.sessionId).toBe('th_1');
    expect(result.isError).toBe(false);
    expect(result).toMatchObject({ tokensIn: 1200, tokensOut: 300, usageReported: true });
    expect(parseCodexText(modern)).toBe('I made the header dark.');
  });

  it('reads the older shape too, because a customer machine may run either', () => {
    const result = parseCodexResult(older);
    expect(result.sessionId).toBe('sess_7');
    expect(result).toMatchObject({ tokensIn: 900, tokensOut: 100, usageReported: true });
    expect(parseCodexText(older)).toBe('The test is failing.');
  });

  it('turns the work into the same flight record a Claude turn produces', () => {
    const { tools } = parseCodexEvents(modern);
    expect(tools.map((t) => t.detail)).toEqual(['Running: npm test', 'Editing src/App.tsx']);
    expect(tools[0]!.ok).toBe(true);
    expect(parseCodexActivity(modern)).toEqual(['Running: npm test', 'Editing src/App.tsx']);
  });

  it('pairs a command with its outcome, and keeps the failure in the tool\'s own words', () => {
    const { tools } = parseCodexEvents(older);
    expect(tools).toHaveLength(1); // begin + end are one command, not two
    expect(tools[0]!.ok).toBe(false);
    expect(tools[0]!.note).toContain('FAIL src/app.test.ts');
  });

  it('a stream that never says the turn finished is a FAILED turn, not a silent success', () => {
    // The whole point: absence of evidence is never evidence of success. A
    // killed process, a crashed CLI, or a shape we cannot read all land here.
    expect(parseCodexResult('').isError).toBe(true);
    expect(parseCodexResult(line({ type: 'item.completed', item: { type: 'agent_message', text: 'done!' } })).isError).toBe(true);
    expect(parseCodexResult('not json at all\n{oops').isError).toBe(true);
  });

  it('an error event fails the turn even when work was done', () => {
    const withError = [modern, line({ type: 'error', message: 'rate limited' })].join('\n');
    expect(parseCodexResult(withError).isError).toBe(true);
  });

  it('says plainly when no usage was reported, rather than reporting a free turn', () => {
    const noUsage = [line({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }), line({ type: 'turn.completed' })].join('\n');
    const result = parseCodexResult(noUsage);
    expect(result.usageReported).toBe(false);
    expect(result.tokensIn).toBe(0);
    expect(result.isError).toBe(false);
  });
});
