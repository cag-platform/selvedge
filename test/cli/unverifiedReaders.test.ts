import { describe, it, expect } from 'vitest';
import { parseCursorSession } from '../../src/cli/sessions/cursor.js';
import { parseGeminiCliSession } from '../../src/cli/sessions/geminiCli.js';
import { rootsFrom } from '../../src/cli/config.js';
import { defaultRoots } from '../../src/cli/sessions/discover.js';
import { summarise } from '../../src/cli/watch.js';
import { checkSessionSummary } from '../../src/shared/types/session.js';

/**
 * THE UNVERIFIED READERS — Cursor and Gemini CLI.
 *
 * These two parsers were written against formats this codebase has not seen a
 * real log from. That is a stated limitation, and what is tested here is
 * whether the limitation is SAFE: does an unverified reader that meets a shape
 * it doesn't understand fail loudly and locally, or does it quietly report a
 * week in which nothing happened?
 *
 * Every test below is a version of that question. There is deliberately no
 * test asserting that a plausible-looking log parses "correctly" against a
 * format nobody has verified — that would be a test of a guess.
 */

describe('cli/sessions — Gemini CLI (unverified)', () => {
  const log = [
    { sessionId: 's-1', type: 'user', message: 'add a health check to the worker', timestamp: '2026-08-01T10:00:00Z' },
    { sessionId: 's-1', type: 'gemini', message: 'Done — added it to worker.ts.', timestamp: '2026-08-01T10:02:00Z' },
    { sessionId: 's-1', type: 'tool', toolCalls: [{ name: 'write_file', args: { file_path: '/home/me/app/worker.ts' } }], timestamp: '2026-08-01T10:01:00Z' },
  ];

  it('reads a JSON array, which is what logs.json is', () => {
    const result = parseGeminiCliSession(JSON.stringify(log));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sessionId).toBe('s-1');
    expect(result.session.intent).toBe('add a health check to the worker');
    expect(result.session.assistantTurns).toBe(1);
    expect(result.session.tools).toEqual({ write_file: 1 });
  });

  it('reads the same content written one object per line', () => {
    const jsonl = log.map((e) => JSON.stringify(e)).join('\n');
    const result = parseGeminiCliSession(jsonl);
    expect(result.ok && result.session.sessionId).toBe('s-1');
  });

  it('keeps a file path relative to where the session ran — never someone\'s home layout', () => {
    const withCwd = [{ ...log[0], cwd: '/home/me/app' }, log[2]];
    const result = parseGeminiCliSession(JSON.stringify(withCwd));
    expect(result.ok && result.session.files).toEqual(['worker.ts']);
  });

  it('REFUSES a log with no session id rather than inventing one', () => {
    const anonymous = JSON.stringify([{ type: 'user', message: 'hello' }]);
    const result = parseGeminiCliSession(anonymous);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/never said which session/);
  });

  it('says it could not read a format it does not recognise, instead of returning an empty session', () => {
    // The failure mode that matters: the tool changed its format. This must not
    // come back as a successfully-parsed session with nothing in it.
    for (const alien of ['<xml>not json at all</xml>', '', 'null', '{"unclosed": ']) {
      const result = parseGeminiCliSession(alien);
      expect(result.ok).toBe(false);
    }
  });

  it('never throws, whatever is in the file', () => {
    for (const nasty of ['[{"parts": 7}]', '[{"toolCalls": "not an array"}]', '[[[]]]', '[{"content": {"parts": [null]}}]']) {
      expect(() => parseGeminiCliSession(nasty)).not.toThrow();
    }
  });
});

describe('cli/sessions — Cursor (unverified)', () => {
  const log = [
    { sessionId: 'c-1', role: 'user', text: 'rename the button', timestamp: '2026-08-01T10:00:00Z', cwd: '/w/app' },
    { sessionId: 'c-1', role: 'assistant', text: 'Renamed.', timestamp: '2026-08-01T10:01:00Z' },
    { sessionId: 'c-1', type: 'tool_call', name: 'edit_file', args: { path: '/w/app/src/Button.tsx' } },
  ];

  it('reads its JSONL, and keeps only the summary', () => {
    const result = parseCursorSession(log.map((e) => JSON.stringify(e)).join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session).toMatchObject({ sessionId: 'c-1', intent: 'rename the button', assistantTurns: 1, files: ['src/Button.tsx'] });
    // Assistant prose is read and discarded — there is nowhere for it to go.
    expect(JSON.stringify(result.session)).not.toContain('Renamed.');
  });

  it('takes the id from composerId when that is what the log calls it', () => {
    const result = parseCursorSession(JSON.stringify([{ composerId: 'c-9', role: 'user', text: 'hi' }]));
    expect(result.ok && result.session.sessionId).toBe('c-9');
  });

  it('REFUSES a log with no session id rather than inventing one', () => {
    expect(parseCursorSession(JSON.stringify([{ role: 'user', text: 'hi' }])).ok).toBe(false);
  });

  it('never throws, whatever is in the file', () => {
    for (const nasty of ['{"tool_calls": {}}', '[{"content": 4}]', 'not json', '[{"args": null, "type": "tool"}]']) {
      expect(() => parseCursorSession(nasty)).not.toThrow();
    }
  });
});

describe('the watch pass — an unverified reader failing is REPORTED', () => {
  const file = { agent: 'cursor' as const, path: '/w/.cursor/sessions/today.jsonl', size: 10, mtimeMs: 0, idHint: undefined };
  const api = { sendSession: async () => ({ ok: true as const, value: {} }) } as never;

  it('turns a log it cannot parse into an unreadable summary with the reason, not into silence', async () => {
    const summary = await summarise(file, { api, readFile: () => '<not json>' });
    expect(summary.outcome).toBe('unreadable');
    expect(summary.detail).toBeTruthy();
    // And it is a LEGAL summary, so the pass sends it rather than dropping it.
    expect(checkSessionSummary(summary).ok).toBe(true);
  });

  it('reports the file by name, never by the path it sits at', async () => {
    const summary = await summarise(file, { api, readFile: () => '<not json>' });
    expect(summary.session_id).toBe('today.jsonl');
    expect(JSON.stringify(summary)).not.toContain('/w/.cursor');
  });

  it('survives a reader that throws outright — the pass keeps its other sessions', async () => {
    const exploding = {
      api,
      readFile: () => {
        throw new Error('disk went away');
      },
    };
    const summary = await summarise(file, exploding);
    expect(summary.outcome).toBe('unreadable');
    expect(summary.detail).toMatch(/disk went away/);
  });
});

describe('cli/config — where the readers look', () => {
  it('lets an owner point an unverified reader somewhere else', () => {
    const roots = rootsFrom(defaultRoots('/home/me'), { cursor: '/elsewhere/cursor' });
    expect(roots.cursor).toBe('/elsewhere/cursor');
    expect(roots.claude).toBe('/home/me/.claude/projects');
  });

  it('turns a reader off when it is set to null, and does not quietly default it back', () => {
    const roots = rootsFrom(defaultRoots('/home/me'), { gemini: null });
    expect(roots.gemini).toBeUndefined();
  });

  it('ignores an override that is only whitespace rather than searching the filesystem root', () => {
    expect(rootsFrom(defaultRoots('/home/me'), { cursor: '   ' }).cursor).toBe('/home/me/.cursor/sessions');
  });
});
