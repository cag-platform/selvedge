import { describe, it, expect } from 'vitest';
import { agentRules, buildAgentPrompt, claudeCommand, parseResult, parseAssistantText, parseToolActivity, parseToolEvents, resultToStep } from '../../src/server/runner/daytona/agentCommand.js';
import type { Card } from '../../src/server/cards/types.js';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'make the gift note optional',
    proposal: 'p', risk: 'ordinary', gate: 'normal', estimate: { lowCents: 1, highCents: 2 },
    stop: { capCents: 1000, checkpointAtFractions: [] }, state: 'working', verdict: null, spentCents: 0,
    backupVerified: false, acts: [], createdAt: 't', updatedAt: 't', ...overrides,
  };
}

describe('buildAgentPrompt — the owner ask, framed to edit in place', () => {
  it('carries the request and forbids deploy (Selvedge ships separately)', () => {
    const p = buildAgentPrompt(card());
    expect(p).toContain('make the gift note optional');
    expect(p).toMatch(/do not .*deploy/i);
  });
});

describe('claudeCommand — one stream-json turn', () => {
  it('builds the CLI command with the model and quoted prompt', () => {
    const cmd = claudeCommand('do a thing', 'sonnet');
    expect(cmd).toContain('claude -p');
    expect(cmd).toContain('--output-format stream-json');
    expect(cmd).toContain('--model sonnet');
    expect(cmd).toContain("'do a thing'");
    expect(cmd).not.toContain('--resume'); // no session yet → fresh conversation
  });

  it('adds --resume when a session id is given — iteration continues the conversation', () => {
    expect(claudeCommand('darker please', 'sonnet', 'sess_1')).toContain("--resume 'sess_1'");
  });

  it('carries the standing rules on every turn, including a resumed one', () => {
    expect(claudeCommand('do a thing', 'sonnet')).toContain('--append-system-prompt');
    expect(claudeCommand('and again', 'sonnet', 'sess_1')).toContain('--append-system-prompt');
  });

  it('a plan turn leaves out the "do the setup work now" half', () => {
    expect(claudeCommand('think about it', 'sonnet', null, 'plan')).not.toContain('Installing packages');
    expect(claudeCommand('build it', 'sonnet', null, 'build')).toContain('Installing packages');
  });
});

/**
 * These rules exist because the agent, given no framing, wrote a founder a
 * "Next Steps for You" list: create a Railway project, run npm install, run
 * pip install, copy your DATABASE_URL. Each assertion below is one way that
 * failure could come back.
 */
describe('agentRules — the agent knows who it is building for', () => {
  const rules = agentRules('build');

  it('says plainly that the reader has no terminal and does not read code', () => {
    expect(rules).toMatch(/does not read code/i);
    expect(rules).toMatch(/no terminal/i);
    expect(rules).toMatch(/never run a command/i);
  });

  it('forbids the handover checklist by name, in the words it actually used', () => {
    expect(rules).toMatch(/npm install/i);
    expect(rules).toMatch(/DATABASE_URL/i);
    expect(rules).toMatch(/checklist/i);
    expect(rules).toMatch(/NEVER end with instructions/i);
  });

  it('makes the setup work the agent\'s own job, not something to hand over', () => {
    expect(rules).toMatch(/YOUR job/i);
    expect(rules).toMatch(/standing up a database/i);
    expect(rules).toMatch(/migrating its schema/i);
  });

  it('tells it the platform contract, so it does not duplicate or fight it', () => {
    expect(rules).toContain('/workspace/app');
    expect(rules).toMatch(/port 3000/i);
    expect(rules).toMatch(/0\.0\.0\.0/);
    expect(rules).toMatch(/do not commit or push/i);
  });

  it('routes secrets through env vars and .env.example, never hard-coded or invented', () => {
    expect(rules).toMatch(/environment\s+variables/i);
    expect(rules).toMatch(/never hard-coded and never invented/i);
    expect(rules).toContain('.env.example');
  });

  it('keeps the honesty rule — a false all-clear is still the worst outcome', () => {
    expect(rules).toMatch(/never claim something works/i);
    expect(rules).toMatch(/false all-clear/i);
  });

  it('bans the developer documentation nobody here will read', () => {
    expect(rules).toMatch(/README/);
    expect(rules).toMatch(/unless you are explicitly asked/i);
  });
});

describe('parseAssistantText — the agent speaks in its own words', () => {
  it('joins the assistant text blocks and skips tool-use noise', () => {
    const out = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I made the header dark."}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Also fixed the contrast."}]}}',
      '{"type":"result","subtype":"success"}',
    ].join('\n');
    expect(parseAssistantText(out)).toBe('I made the header dark.\n\nAlso fixed the contrast.');
  });

  it('returns empty for a stream with no assistant text', () => {
    expect(parseAssistantText('{"type":"result","subtype":"success"}')).toBe('');
  });
});

describe('parseResult — read the final result event from stream-json stdout', () => {
  it('extracts cost and success from the last result line', () => {
    const out = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.0123,"session_id":"s","is_error":false}',
    ].join('\n');
    expect(parseResult(out)).toEqual({ subtype: 'success', totalCostUsd: 0.0123, sessionId: 's', isError: false });
  });

  it('captures the session id so the next turn can --resume the conversation', () => {
    const out = '{"type":"result","subtype":"success","total_cost_usd":0.01,"session_id":"sess_abc","is_error":false}';
    expect(parseResult(out)!.sessionId).toBe('sess_abc');
  });

  it('treats a non-success subtype as an error', () => {
    const out = '{"type":"result","subtype":"error_max_turns","total_cost_usd":0.5,"is_error":false}';
    expect(parseResult(out)!.isError).toBe(true);
  });

  it('returns null when there is no result line (a crashed or killed run)', () => {
    expect(parseResult('some raw log with no json result')).toBeNull();
  });
});

describe('resultToStep — real cost into the runner, one turn is done', () => {
  it('converts dollars to cents and reports the change was made', () => {
    const step = resultToStep({ subtype: 'success', totalCostUsd: 0.0123, sessionId: null, isError: false });
    expect(step.spentCents).toBe(1); // rounded
    expect(step.done).toBe(true);
    expect(step.note).toMatch(/made the change/i);
  });

  it('a missing result is done with a note, not a hidden success — verification judges it', () => {
    const step = resultToStep(null);
    expect(step.done).toBe(true);
    expect(step.spentCents).toBe(0);
    expect(step.note).toMatch(/did not return a result/i);
  });

  it('an errored turn still records its cost and flags the problem', () => {
    const step = resultToStep({ subtype: 'error_during_execution', totalCostUsd: 0.2, sessionId: null, isError: true });
    expect(step.spentCents).toBe(20);
    expect(step.note).toMatch(/reported a problem/i);
  });
});

describe('parseToolEvents — the flight recorder: structured, bounded, outcome-aware', () => {
  const use = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (tool_use_id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, ...over }] } });

  it('captures the call AND its outcome — the pair no parser read before', () => {
    const log = [
      use('t1', 'Edit', { file_path: '/workspace/app/src/App.tsx', old_string: 'a', new_string: 'b' }),
      result('t1'),
      use('t2', 'Bash', { command: 'npm test' }),
      result('t2', { is_error: true, content: 'FAIL src/App.test.tsx — expected 2, got 3' }),
    ].join('\n');
    const { tools, truncated } = parseToolEvents(log);
    expect(truncated).toBe(false);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: 't1', name: 'Edit', detail: 'Editing src/App.tsx', ok: true });
    expect(tools[0]!.input).toMatchObject({ file_path: '/workspace/app/src/App.tsx', old_string: 'a', new_string: 'b' });
    expect(tools[1]).toMatchObject({ id: 't2', name: 'Bash', ok: false });
    expect(tools[1]!.note).toMatch(/expected 2, got 3/);
  });

  it('a call with no result carries no verdict — absence is not success', () => {
    const { tools } = parseToolEvents(use('t9', 'Read', { file_path: '/workspace/app/x.ts' }));
    expect(tools[0]!.ok).toBeUndefined();
    expect(tools[0]!.note).toBeUndefined();
  });

  it('bounds huge inputs per field and says nothing false about the rest', () => {
    const big = 'x'.repeat(10_000);
    const { tools } = parseToolEvents(use('t1', 'Write', { file_path: '/workspace/app/a.ts', content: big }));
    expect(tools[0]!.input!.content!.length).toBeLessThanOrEqual(2000);
    expect(tools[0]!.input!.content!.endsWith('…')).toBe(true);
  });

  it('caps the event count and admits the cut with truncated:true', () => {
    const log = Array.from({ length: 210 }, (_, i) => use(`t${i}`, 'Read', { file_path: `/workspace/app/f${i}.ts` })).join('\n');
    const { tools, truncated } = parseToolEvents(log);
    expect(tools).toHaveLength(200);
    expect(truncated).toBe(true);
  });

  it('a failed result note is bounded too', () => {
    const { tools } = parseToolEvents(
      [use('t1', 'Bash', { command: 'npm run build' }), result('t1', { is_error: true, content: 'e'.repeat(3000) })].join('\n'),
    );
    expect(tools[0]!.note!.length).toBeLessThanOrEqual(500);
  });

  it('parseToolActivity is a pure projection — the live feed and the record can never disagree', () => {
    const log = [
      use('t1', 'Edit', { file_path: '/workspace/app/src/App.tsx' }),
      use('t2', 'Grep', { pattern: 'checkout' }),
      use('t3', 'SomeMcpTool', { arg: 1 }),
    ].join('\n');
    expect(parseToolActivity(log)).toEqual(parseToolEvents(log).tools.map((t) => t.detail));
    expect(parseToolActivity(log)).toEqual(['Editing src/App.tsx', 'Searching for checkout', 'Using SomeMcpTool']);
  });
});
