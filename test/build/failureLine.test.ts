import { describe, it, expect } from 'vitest';
import { buildFailureLine, tailOf } from '../../src/server/build/agent.js';

/**
 * "I hit a problem and couldn't finish that" is true and unactionable. The
 * exit code and the whole log were right there and were thrown away, so
 * nobody — including whoever is debugging it — could tell an uninstalled CLI
 * from a bad key from a repo that wouldn't build.
 */
describe('build/agent — a turn that fails says which failure', () => {
  describe('the part of a log a person can act on', () => {
    it('keeps the CLI\'s own words and drops the machine lines', () => {
      const log = [
        '{"type":"system","subtype":"init","session_id":"abc"}',
        '{"type":"assistant","message":{"content":[]}}',
        'bash: codex: command not found',
        '__EXIT:127',
      ].join('\n');
      expect(tailOf(log)).toBe('bash: codex: command not found');
    });

    it('is nothing when the log is all machine', () => {
      expect(tailOf('{"type":"system"}\n{"type":"result"}\n__EXIT:0')).toBeNull();
      expect(tailOf('')).toBeNull();
    });

    it('keeps the END of a long complaint, which is where the cause is', () => {
      const said = tailOf(`error: ${'x'.repeat(500)}THE ACTUAL PROBLEM`);
      expect(said).toContain('THE ACTUAL PROBLEM');
      expect(said!.length).toBeLessThan(320);
    });
  });

  describe('the sentence the owner reads', () => {
    it('blames the install when the install is what failed', () => {
      // Everything downstream of a failed install fails with a symptom rather
      // than a cause, so this has to be checked first.
      const line = buildFailureLine('Codex', 'npm ERR! 404 Not Found', 'irrelevant', 1);
      expect(line).toContain("couldn't be installed in the workshop");
      expect(line).toContain('npm ERR! 404 Not Found');
      expect(line).toContain('Nothing was shipped');
    });

    it('quotes what the agent said when it said something', () => {
      const line = buildFailureLine('Codex', null, 'bash: codex: command not found\n__EXIT:127', 127);
      expect(line).toContain('command not found');
      expect(line).toContain('Codex stopped without finishing');
    });

    it('names the exit code when the agent said nothing at all', () => {
      // Still better than a shrug: a code is something to search for, and a
      // repeat of it is a workshop problem rather than a phrasing problem.
      const line = buildFailureLine('Codex', null, '{"type":"system"}\n__EXIT:137', 137);
      expect(line).toContain('exited with code 137');
      expect(line).toContain('worth looking at the workshop itself');
    });

    it('falls back to the plain sentence when there is genuinely nothing to say', () => {
      expect(buildFailureLine('Codex', null, null, null)).toContain("I hit a problem and couldn't finish that");
    });

    it('never claims something shipped', () => {
      // The one thing every branch must carry: a failed turn changed nothing.
      for (const line of [
        buildFailureLine('Codex', 'install broke', null, 1),
        buildFailureLine('Codex', null, 'permission denied\n__EXIT:1', 1),
        buildFailureLine('Codex', null, '{"a":1}\n__EXIT:9', 9),
        buildFailureLine('Codex', null, null, null),
      ]) {
        expect(line).toMatch(/[Nn]othing was shipped/);
      }
    });
  });
});
