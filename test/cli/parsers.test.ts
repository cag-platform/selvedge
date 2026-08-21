import { describe, it, expect } from 'vitest';
import { parseClaudeSession } from '../../src/cli/sessions/claude.js';
import { parseCodexSession } from '../../src/cli/sessions/codex.js';
import { outcomeOf, toSummary } from '../../src/cli/sessions/parse.js';

const line = (o: unknown) => JSON.stringify(o);

/**
 * Reading someone else's log. Both formats are undocumented and both have
 * changed shape between versions, so what is pinned here is the behaviour that
 * makes the companion trustworthy: it takes only the summary, it never guesses,
 * and a log it cannot read is an honest failure rather than a silent gap.
 */
describe('reading a Claude Code session', () => {
  const log = [
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' }, sessionId: 's1', cwd: '/home/me/loom', timestamp: '2026-08-20T09:00:00Z' }),
    line({ type: 'user', message: { role: 'user', content: 'the basket empties itself when you go back' }, sessionId: 's1', cwd: '/home/me/loom', timestamp: '2026-08-20T09:01:00Z' }),
    line({
      type: 'assistant',
      costUSD: 0.021,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look at the cart.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/me/loom/src/checkout/Cart.tsx' } },
        ],
      },
      sessionId: 's1',
      timestamp: '2026-08-20T09:02:00Z',
    }),
    line({
      type: 'assistant',
      costUSD: 0.044,
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/me/loom/src/checkout/Cart.tsx' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
      sessionId: 's1',
      timestamp: '2026-08-20T09:20:00Z',
    }),
  ].join('\n');

  it('takes the ask, the files, the tools and the cost — and nothing else', () => {
    const parsed = parseClaudeSession(log);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s = parsed.session;
    expect(s.sessionId).toBe('s1');
    expect(s.cwd).toBe('/home/me/loom');
    expect(s.intent).toBe('the basket empties itself when you go back');
    // Paths are recorded relative to the session's directory: a summary should
    // not carry someone's home folder layout.
    expect(s.files).toEqual(['src/checkout/Cart.tsx']);
    expect(s.tools).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(s.costUsd).toBeCloseTo(0.065, 3);
    expect(s.startedAt?.toISOString()).toBe('2026-08-20T09:00:00.000Z');
    expect(s.endedAt?.toISOString()).toBe('2026-08-20T09:20:00.000Z');

    // The summary that would be sent carries no prose from the conversation.
    const summary = JSON.stringify(toSummary(s));
    expect(summary).not.toContain('Let me look at the cart');
  });

  it('skips the CLI\'s own chatter when looking for what was asked', () => {
    const parsed = parseClaudeSession(log);
    if (!parsed.ok) return;
    expect(parsed.session.intent).not.toContain('command-name');
  });

  it('reports a log it cannot read instead of inventing a session', () => {
    expect(parseClaudeSession('')).toMatchObject({ ok: false });
    expect(parseClaudeSession('not json\nnot json either')).toMatchObject({ ok: false });
    // Entries with no session id anywhere: unreadable, not "session undefined".
    expect(parseClaudeSession(line({ type: 'assistant', message: { content: [] } }))).toMatchObject({ ok: false });
  });

  it('falls back to the session id in the filename, which is where Claude puts it', () => {
    const parsed = parseClaudeSession(line({ type: 'user', message: { content: 'hello' }, cwd: '/x' }), 'from-filename');
    expect(parsed.ok && parsed.session.sessionId).toBe('from-filename');
  });

  it('says nothing about cost when the log said nothing about cost', () => {
    const parsed = parseClaudeSession(line({ type: 'assistant', sessionId: 's2', message: { content: [] } }));
    expect(parsed.ok && parsed.session.costUsd).toBeNull();
  });

  it('notices an error the tool reported', () => {
    const withError = [line({ type: 'user', sessionId: 's3', message: { content: 'go' } }), line({ type: 'error', sessionId: 's3' })].join('\n');
    const parsed = parseClaudeSession(withError);
    expect(parsed.ok && outcomeOf(parsed.session)).toBe('error');
  });

  it('calls a session where nothing happened abandoned', () => {
    const parsed = parseClaudeSession(line({ type: 'user', sessionId: 's4', message: { content: 'never mind' } }));
    expect(parsed.ok && outcomeOf(parsed.session)).toBe('abandoned');
  });
});

describe('reading a Codex session', () => {
  const modern = [
    line({ timestamp: '2026-08-20T10:00:00Z', type: 'session_meta', payload: { id: 'cx1', cwd: '/home/me/loom', cli_version: '0.9' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make the checkout one page' }] } }),
    line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}' } }),
    line({
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Update File: src/checkout/Cart.tsx\n@@\n-old\n+new' }) },
    }),
    line({ timestamp: '2026-08-20T10:40:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
  ].join('\n');

  it('reads the session, the ask, the tools and the files it patched', () => {
    const parsed = parseCodexSession(modern);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.session.sessionId).toBe('cx1');
    expect(parsed.session.cwd).toBe('/home/me/loom');
    expect(parsed.session.intent).toBe('make the checkout one page');
    expect(parsed.session.tools).toEqual({ shell: 1, apply_patch: 1 });
    expect(parsed.session.files).toEqual(['src/checkout/Cart.tsx']);
    expect(parsed.session.assistantTurns).toBe(1);
    // The patch body itself is read and dropped — only the file name survives.
    expect(JSON.stringify(toSummary(parsed.session))).not.toContain('+new');
  });

  it('reads an older shape too, because a machine may be running either', () => {
    const older = [
      line({ timestamp: '2026-08-19T10:00:00Z', msg: { type: 'session_configured', session_id: 'cx2', cwd: '/home/me/ravel' } }),
      line({ msg: { type: 'message', role: 'user', content: 'fix the footer' } }),
      line({ msg: { type: 'local_shell_call', name: 'shell', arguments: { command: ['ls'] } } }),
    ].join('\n');
    const parsed = parseCodexSession(older);
    expect(parsed.ok && parsed.session.sessionId).toBe('cx2');
    expect(parsed.ok && parsed.session.intent).toBe('fix the footer');
  });

  it('reports a shape it does not recognise rather than guessing at one', () => {
    expect(parseCodexSession(line({ something: 'entirely else' }))).toMatchObject({ ok: false });
    expect(parseCodexSession('')).toMatchObject({ ok: false });
  });
});
