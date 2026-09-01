import { describe, expect, it } from 'vitest';
import { autoCapability, chooseAutoAgent } from '../../src/server/threads/autoRoute.js';

const candidates = [
  { id: 'claude' as const, changes_files: false, available: true },
  { id: 'gpt' as const, changes_files: false, available: true },
  { id: 'claude-code' as const, changes_files: true, available: true },
  { id: 'codex' as const, changes_files: true, available: true },
];

describe('automatic agent routing', () => {
  it('keeps questions conversational even inside a project', () => {
    expect(autoCapability('What is causing this error?', true)).toBe('talk');
    expect(autoCapability('Review the authentication flow', true)).toBe('talk');
  });

  it('uses a builder only for an explicit change', () => {
    expect(autoCapability('Fix the authentication flow', true)).toBe('build');
    expect(autoCapability('Add the new checkout screen', true)).toBe('build');
    expect(autoCapability('Fix it', false)).toBe('talk');
  });

  it('uses the owner preference when it fits and is available', () => {
    const out = chooseAutoAgent({ text: 'Fix the login', hasProject: true, current: 'claude', preferred: ['codex'], candidates });
    expect(out).toMatchObject({ agent: 'codex', capability: 'build', used_preference: true });
  });

  it('preserves the current capable agent when there is no matching preference', () => {
    const out = chooseAutoAgent({ text: 'Explain this failure', hasProject: true, current: 'gpt', preferred: ['codex'], candidates });
    expect(out).toMatchObject({ agent: 'gpt', capability: 'talk', used_preference: false });
  });

  it('avoids a recently failed builder when another is available', () => {
    const out = chooseAutoAgent({ text: 'Implement the fix', hasProject: true, current: 'claude-code', preferred: [], candidates, recentlyFailed: new Set(['claude-code']) });
    expect(out).toMatchObject({ agent: 'codex', avoided_recent_failure: true });
  });
});
