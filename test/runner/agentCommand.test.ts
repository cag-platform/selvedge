import { describe, it, expect } from 'vitest';
import { buildAgentPrompt, claudeCommand, parseResult, parseAssistantText, resultToStep } from '../../src/server/runner/daytona/agentCommand.js';
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
