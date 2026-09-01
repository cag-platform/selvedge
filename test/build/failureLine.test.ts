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
    it('gives one recovery action when setup failed', () => {
      const line = buildFailureLine('Codex', 'npm ERR! 404 Not Found', 'irrelevant', 1);
      expect(line).toBe('Codex could not start. Reconnect it and retry.');
    });

    it('keeps the raw failure out of the owner-facing line', () => {
      const line = buildFailureLine('Codex', null, 'bash: codex: command not found\n__EXIT:127', 127);
      expect(line).toBe('Codex stopped. Retry or view technical details.');
    });

    it('hides the exit code when the agent said nothing at all', () => {
      const line = buildFailureLine('Codex', null, '{"type":"system"}\n__EXIT:137', 137);
      expect(line).toBe('Codex stopped unexpectedly. Retry.');
    });

    it('falls back to the plain sentence when there is genuinely nothing to say', () => {
      expect(buildFailureLine('Codex', null, null, null)).toBe('That did not finish. Retry.');
    });

    it('never leaks the workshop log', () => {
      for (const line of [
        buildFailureLine('Codex', 'install broke', null, 1),
        buildFailureLine('Codex', null, 'permission denied\n__EXIT:1', 1),
        buildFailureLine('Codex', null, '{"a":1}\n__EXIT:9', 9),
        buildFailureLine('Codex', null, null, null),
      ]) {
        expect(line).not.toMatch(/install broke|permission denied|__EXIT/);
      }
    });
  });
});
