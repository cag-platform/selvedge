import { describe, it, expect } from 'vitest';
import { agentModelFromEnv } from '../../src/server/runner/native/factory.js';

/**
 * The regression guard for a bug that shipped precisely because nothing asserted
 * it: EVAL_MODEL — documented as "judges acceptance on a different model than
 * authored the change" — was being read as the model the agent AUTHORED with.
 * Setting it did the exact opposite of what it promised, and quietly.
 *
 * The rule this locks: the grader's variable never selects the author's model.
 */
describe('agentModelFromEnv — the author’s model, never the grader’s', () => {
  it('reads AGENT_MODEL', () => {
    expect(agentModelFromEnv({ AGENT_MODEL: 'claude-opus-5' } as NodeJS.ProcessEnv)).toBe('claude-opus-5');
  });

  it('IGNORES EVAL_MODEL — the bug this file exists for', () => {
    // If this ever comes back, a deploy that configured an independent grader
    // would silently change which model writes the customer's code.
    expect(agentModelFromEnv({ EVAL_MODEL: 'gpt-5' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('lets the CLI pick its own default when unset, rather than inventing one', () => {
    expect(agentModelFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('treats a blank value as unset, matching every other env read', () => {
    expect(agentModelFromEnv({ AGENT_MODEL: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
