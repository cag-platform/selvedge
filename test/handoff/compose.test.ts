import { describe, it, expect } from 'vitest';
import { composeHandoff, projectLines, standingLines } from '../../src/server/handoff/compose.js';
import { loomPack, loomThread } from '../fixtures/handoffThread.js';
import { estimateTokens } from '../../src/shared/tokens.js';
import { makeTestPack } from '../fixtures/testPack.js';

/**
 * The handoff is the Inbox's load-bearing claim: switch builders mid-task and
 * nothing has to be re-explained. These tests hold it to the three things that
 * makes true — it carries what the new agent cannot work out for itself, it
 * costs a fraction of the conversation it stands in for, and it never says
 * anything it wasn't given.
 */
describe('composeHandoff — what the next agent needs, and nothing else', () => {
  it('carries the project: what it is, what it costs when it breaks, what it is built from', () => {
    const payload = composeHandoff(loomPack(), loomThread(), 'codex');
    expect(payload.text).toContain('Loom');
    expect(payload.text).toContain('made-to-measure curtain shop');
    expect(payload.text).toMatch(/live software with real users, it handles money/i);
    expect(payload.text).toContain('Nobody can order curtains');
    expect(payload.text).toContain('Next.js on Railway');
    // The two things a fresh agent would otherwise burn a turn rediscovering.
    expect(payload.text).toMatch(/flaky/i);
    expect(payload.text).toContain('nothing reports front-end errors yet');
  });

  it('carries the work: what was asked, what was answered, what was touched, what it cost', () => {
    const payload = composeHandoff(loomPack(), loomThread(), 'codex');
    expect(payload.text).toContain('Checkout rework');
    expect(payload.text).toMatch(/The owner asked:/);
    expect(payload.text).toContain('Claude Code:');
    expect(payload.text).toContain('src/checkout/Cart.tsx');
    expect(payload.text).toContain('Shipped a1b2c3d');
    expect(payload.text).toMatch(/undone here once/);
    expect(payload.text).toContain('$0.73'); // 18 + 24 + 31 cents, said plainly
  });

  it('the unanswered ask becomes the instruction, verbatim and unabridged', () => {
    const thread = loomThread(8, 'ask');
    const payload = composeHandoff(loomPack(), thread, 'codex');
    const ask = thread.messages.at(-1)!.content;
    expect(payload.sections.ask).toBe(ask);
    expect(payload.text).toContain('WHAT YOU ARE BEING ASKED TO DO NOW');
    expect(payload.text).toContain(ask);
    // ...and it is said once, not twice — the story stops before it.
    expect(payload.text.split(ask)).toHaveLength(2);
  });

  it('an ask the last agent already answered is history, not a new instruction', () => {
    // Sending a finished ask as the instruction is how a switched-in agent
    // redoes work that was already done, on the owner's money.
    const payload = composeHandoff(loomPack(), loomThread(8, 'reply'), 'codex');
    expect(payload.sections.ask).toBeNull();
    expect(payload.text).toMatch(/Nothing new has been asked yet/);
  });

  it('costs under a tenth of the transcript it stands in for, on a thread with real history', () => {
    // Twenty rounds of work — the point at which someone actually switches
    // builders mid-task, and at which pasting the conversation actually hurts.
    const payload = composeHandoff(loomPack(), loomThread(20), 'codex');
    expect(payload.estimated_tokens / payload.transcript_tokens).toBeLessThan(0.1);
    // The counts are the same estimator on both sides, so the ratio means
    // something even though neither number is a tokenizer's answer.
    expect(payload.estimated_tokens).toBe(estimateTokens(payload.text));
  });

  it('is bounded absolutely, so a year-long thread hands over for the price of a week-old one', () => {
    const long = composeHandoff(loomPack(), loomThread(60), 'codex');
    const longer = composeHandoff(loomPack(), loomThread(120), 'codex');
    expect(long.estimated_tokens).toBeLessThan(1000);
    expect(Math.abs(longer.estimated_tokens - long.estimated_tokens)).toBeLessThan(30);
    expect(longer.estimated_tokens / longer.transcript_tokens).toBeLessThan(0.02);
    // What was dropped is stated, never quietly disappeared.
    expect(long.sections.omitted).toBeGreaterThan(0);
    expect(long.text).toMatch(/earlier lines of this conversation left out/);
    expect(composeHandoff(loomPack(), loomThread(3), 'codex').sections.omitted).toBe(0);
  });

  it('does not pretend to compress a thread with nothing in it yet', () => {
    // On a four-message thread the payload is BIGGER than the transcript,
    // because what the next agent needs to know about a live shop that takes
    // money is a fixed cost and this thread has nothing to compress. That is
    // the right trade, and it is recorded here rather than averaged away.
    const tiny = composeHandoff(loomPack(), loomThread(2), 'codex');
    expect(tiny.estimated_tokens).toBeGreaterThan(tiny.transcript_tokens);
    expect(tiny.estimated_tokens).toBeLessThan(1000);
  });

  it('says where the work stands, which is the thing a new agent must not guess', () => {
    const staged = composeHandoff(loomPack(), { ...loomThread(), stagedChangesReady: true }, 'codex');
    expect(staged.text).toMatch(/have NOT been shipped yet/);
    expect(staged.text).toMatch(/do not start over/i);

    const clean = composeHandoff(loomPack(), { ...loomThread(), stagedChangesReady: false }, 'codex');
    expect(clean.text).toMatch(/Nothing is waiting to ship/);
  });

  it('warns when the last turn failed, because half-done work looks like no work', () => {
    const thread = loomThread();
    thread.runs = [...(thread.runs ?? []), { kind: 'turn', status: 'failed', costCents: 12 }];
    expect(composeHandoff(loomPack(), thread, 'codex').text).toMatch(/failed partway/);
  });

  it('collapses the repeats instead of narrating them eleven times', () => {
    const payload = composeHandoff(loomPack(), loomThread(), 'codex');
    expect(payload.text).toMatch(/Running: npm test \(\d+ times\)/);
  });

  it('invents nothing when there is no pack — it says so instead', () => {
    const payload = composeHandoff(null, loomThread(), 'codex');
    expect(payload.text).toMatch(/don't have a context pack/i);
    expect(payload.text).not.toContain('Loom');
    expect(payload.text).toContain('WHAT YOU ARE BEING ASKED TO DO NOW');
  });

  it('handles a thread with nothing in it without pretending otherwise', () => {
    const payload = composeHandoff(loomPack(), { id: 't', title: 'New thread', kind: 'general', agent: 'claude', messages: [] }, 'gpt');
    expect(payload.sections.ask).toBeNull();
    expect(payload.text).toMatch(/Nothing new has been asked yet/);
    expect(payload.transcript_tokens).toBe(0);
    // A general thread has no sandbox, so it never speaks about shipping.
    expect(payload.text).not.toMatch(/ship/i);
  });

  it('is deterministic and pure — same inputs, same bytes', () => {
    const pack = loomPack();
    const thread = loomThread();
    expect(composeHandoff(pack, thread, 'codex').text).toBe(composeHandoff(pack, thread, 'codex').text);
    // ...and it does not touch what it was given.
    const before = JSON.stringify(thread);
    composeHandoff(pack, thread, 'codex');
    expect(JSON.stringify(thread)).toBe(before);
  });

  it('records who handed over to whom, for the line the thread will show', () => {
    const payload = composeHandoff(loomPack(), loomThread(), 'codex');
    expect(payload.from_agent).toBe('claude-code');
    expect(payload.to_agent).toBe('codex');
    expect(payload.thread_id).toBe('01J8Z5M9QK7T2R4N6P0V3W1XYZ');
    expect(payload.text).toContain('from Claude Code');
  });

  it('a sandbox project is described as one — the stakes line is read, not assumed', () => {
    const lines = projectLines(makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } }));
    expect(lines.join('\n')).toMatch(/A sandbox — nothing depends on it yet/);
    expect(lines.join('\n')).not.toMatch(/handles money/);
  });

  it('a general thread is never told about staged changes it cannot have', () => {
    expect(standingLines({ id: 't', title: 'x', kind: 'general', agent: 'claude', messages: [] })).toEqual([]);
  });
});
