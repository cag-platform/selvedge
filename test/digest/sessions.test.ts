import { describe, it, expect } from 'vitest';
import { externalSessionLines, type SessionForBrief } from '../../src/server/digest/sessions.js';
import { makeTestPack } from '../fixtures/testPack.js';

const packs = [
  makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }),
  makeTestPack({ identity: { project_id: 'ravel', name: 'Ravel', owner_description: 'x' } }),
];

const session = (over: Partial<SessionForBrief> = {}): SessionForBrief => ({
  agent: 'claude-code',
  projectId: 'loom',
  outcome: 'ended',
  intent: null,
  detail: null,
  ...over,
});

/**
 * Yesterday's terminal work, arriving in the brief. Two things are held here:
 * the line always says the work happened OUTSIDE Selvedge (it was not gated,
 * not verified, not watched), and a session the companion couldn't read is said
 * out loud and said first.
 */
describe('what the brief says about work done outside Selvedge', () => {
  it('says nothing on a day with nothing', () => {
    expect(externalSessionLines([], packs)).toEqual([]);
  });

  it('names the tool, the project, and how each session ended', () => {
    const lines = externalSessionLines(
      [
        session({ outcome: 'shipped', intent: 'the checkout refactor' }),
        session({ outcome: 'abandoned' }),
      ],
      packs,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Yesterday, outside Selvedge: two Claude Code sessions on Loom — one shipped (the checkout refactor), one abandoned.');
  });

  it('keeps projects apart, and never claims the work was checked', () => {
    const line = externalSessionLines(
      [session({ outcome: 'shipped' }), session({ projectId: 'ravel', agent: 'codex', outcome: 'ended' })],
      packs,
    )[0]!;
    expect(line).toContain('on Loom');
    expect(line).toContain('on Ravel');
    expect(line).toContain('outside Selvedge');
    expect(line).not.toMatch(/verified|checked|held up/i);
  });

  it('says plainly when it could not place a session, rather than guessing at a project', () => {
    const line = externalSessionLines([session({ projectId: null })], packs)[0]!;
    expect(line).toContain('a project I could not place');
  });

  it('leads with what it could not read, and says why', () => {
    const lines = externalSessionLines(
      [
        session({ agent: 'codex', outcome: 'unreadable', detail: 'the log never said which session it was' }),
        session({ outcome: 'shipped' }),
      ],
      packs,
    );
    // First, because a gap the owner doesn't know about is the failure that
    // matters — a morning that narrates three of five sessions silently is worse
    // than one that admits to two it couldn't read.
    expect(lines[0]).toMatch(/^I couldn't read one of yesterday's Codex sessions/);
    expect(lines[0]).toContain('the log never said which session it was');
    expect(lines[1]).toContain('one Claude Code session on Loom — shipped');
  });

  it('counts plurals like a person', () => {
    const one = externalSessionLines([session()], packs)[0]!;
    expect(one).toContain('one Claude Code session on Loom');
    const three = externalSessionLines([session(), session(), session()], packs)[0]!;
    expect(three).toContain('three Claude Code sessions on Loom');
  });
});
