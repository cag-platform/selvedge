import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchOnce, dryRun, summarise } from '../../src/cli/watch.js';
import type { SessionSummary } from '../../src/shared/types/session.js';

/**
 * The watch pass, against a real directory of real session files.
 *
 * Two promises are under test here and they are the whole reason anyone would
 * run this on their own machine: what leaves is only the summary, and a session
 * that cannot be read is REPORTED rather than dropped. A companion that quietly
 * skips what it can't parse is worse than none, because the owner would never
 * learn that Thursday went missing.
 */
describe('the companion watch', () => {
  let home: string;
  let sent: SessionSummary[];
  let statePath: string;

  const api = {
    sendSession: async (summary: SessionSummary) => {
      sent.push(summary);
      return { ok: true as const, value: { recorded: true, project_id: 'loom' } };
    },
  };

  const oldEnough = (file: string) => {
    const long_ago = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, long_ago, long_ago);
  };

  const claudeLog = (sessionId: string) =>
    [
      JSON.stringify({ type: 'user', sessionId, cwd: '/home/me/loom', timestamp: '2026-08-20T09:00:00Z', message: { content: 'fix the checkout' } }),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        costUSD: 0.02,
        timestamp: '2026-08-20T09:10:00Z',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/me/loom/src/Cart.tsx' } }] },
      }),
    ].join('\n');

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'selvedge-watch-'));
    statePath = path.join(home, 'state.json');
    sent = [];
    mkdirSync(path.join(home, '.claude', 'projects', 'loom'), { recursive: true });
    mkdirSync(path.join(home, '.codex', 'sessions', '2026', '08', '20'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const roots = () => ({ claude: path.join(home, '.claude', 'projects'), codex: path.join(home, '.codex', 'sessions') });

  const deps = () => ({
    api: api as never,
    roots: roots(),
    statePath,
    repoFor: async () => 'acme/loom',
    commitDuring: async () => null,
  });

  it('sends a summary of a finished session, and only a summary', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-1.jsonl');
    writeFileSync(file, claudeLog('sess-1'));
    oldEnough(file);

    const result = await watchOnce(deps());
    expect(result.sent).toBe(1);
    expect(sent[0]).toMatchObject({
      agent: 'claude-code',
      session_id: 'sess-1',
      intent: 'fix the checkout',
      files_touched: ['src/Cart.tsx'],
      tools_run: { Edit: 1 },
      repo: 'acme/loom',
      outcome: 'ended',
    });
    // Nothing that could carry the work itself.
    expect(Object.keys(sent[0]!)).not.toContain('transcript');
    expect(JSON.stringify(sent[0])).not.toContain('tool_use');
  });

  it('leaves a session that is still being written alone', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'live.jsonl');
    writeFileSync(file, claudeLog('live')); // fresh mtime: someone is still typing
    const result = await watchOnce(deps());
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('does not send the same session twice, and does send it again when it grows', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-2.jsonl');
    writeFileSync(file, claudeLog('sess-2'));
    oldEnough(file);
    await watchOnce(deps());
    expect(sent).toHaveLength(1);

    await watchOnce(deps());
    expect(sent).toHaveLength(1); // nothing changed, nothing re-sent

    // The owner resumed it: the summary is sent again, and the server keys on
    // the session id so the record updates rather than duplicating.
    writeFileSync(file, `${claudeLog('sess-2')}\n${JSON.stringify({ type: 'assistant', sessionId: 'sess-2', message: { content: [] } })}`);
    oldEnough(file);
    await watchOnce(deps());
    expect(sent).toHaveLength(2);
    expect(sent[1]!.session_id).toBe('sess-2');
  });

  it('REPORTS a log it cannot read, rather than skipping it', async () => {
    const file = path.join(home, '.codex', 'sessions', '2026', '08', '20', 'rollout-2026-08-20T09-00-00-4f1c2b8a-9e77-4c31-8a55-2b6d0e19cc10.jsonl');
    writeFileSync(file, 'this is not a session log at all');
    oldEnough(file);

    const result = await watchOnce(deps());
    expect(result.unreadable).toBe(1);
    expect(sent[0]).toMatchObject({ agent: 'codex', outcome: 'unreadable' });
    expect(sent[0]!.detail).toBeTruthy();
    // It still names the session, so the brief can say which one went missing.
    expect(sent[0]!.session_id).toBe('4f1c2b8a-9e77-4c31-8a55-2b6d0e19cc10');
  });

  it('links the commit that landed while the session was open, and calls that shipped', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-3.jsonl');
    writeFileSync(file, claudeLog('sess-3'));
    oldEnough(file);

    const summary = await summarise(
      { agent: 'claude-code', path: file, size: 1, mtimeMs: 1, idHint: 'sess-3' },
      { ...deps(), commitDuring: async () => 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' },
    );
    expect(summary.outcome).toBe('shipped');
    expect(summary.commit_sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });

  it('a dry run sends nothing at all, and prints what it would have sent', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-4.jsonl');
    writeFileSync(file, claudeLog('sess-4'));
    oldEnough(file);

    const summaries = await dryRun(deps());
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.session_id).toBe('sess-4');
    expect(sent).toHaveLength(0);
  });

  it('a machine that has never run either tool is not an error', async () => {
    const result = await watchOnce({ ...deps(), roots: { claude: path.join(home, 'nope'), codex: path.join(home, 'also-nope') } });
    expect(result).toMatchObject({ considered: 0, sent: 0, failed: 0 });
  });

  it('a send that fails leaves the session unsent, to go again next pass', async () => {
    const file = path.join(home, '.claude', 'projects', 'loom', 'sess-5.jsonl');
    writeFileSync(file, claudeLog('sess-5'));
    oldEnough(file);

    const failing = { sendSession: async () => ({ ok: false as const, error: 'offline' }) };
    const first = await watchOnce({ ...deps(), api: failing as never });
    expect(first.failed).toBe(1);

    const second = await watchOnce(deps());
    expect(second.sent).toBe(1); // not marked as sent, so it goes when the network is back
  });
});
