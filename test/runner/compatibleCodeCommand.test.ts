import { describe, expect, it } from 'vitest';
import { compatibleCodeCommand, compatibleInstallCommand, parseCompatible } from '../../src/server/runner/workers/compatibleCodeCommand.js';

describe('neutral coding harness commands', () => {
  it('runs Kimi non-interactively and uses its documented in-memory credential channel', () => {
    const command = compatibleCodeCommand('kimi-code', 'make it useful', { mode: 'build' });
    expect(command).toContain('kimi');
    expect(command).toContain('--output-format stream-json');
    expect(command).not.toContain('KIMI_API_KEY');
    expect(command).not.toContain('make it useful');
    expect(compatibleInstallCommand('kimi-code')).toContain('@moonshot-ai/kimi-code');
  });

  it('runs Grok headlessly with explicit approval inside the isolated workspace', () => {
    const command = compatibleCodeCommand('grok-build', 'fix this', { mode: 'build', resumeSessionId: 'abc' });
    expect(command).toContain('grok');
    expect(command).toContain('--output-format streaming-json');
    expect(command).toContain('--always-approve');
    expect(command).toContain('--session-id');
    expect(command).toContain('abc');
    expect(compatibleInstallCommand('grok-build')).toContain('https://x.ai/cli/install.sh');
  });

  it('extracts assistant text, a session, and bounded tool evidence without depending on one vendor envelope', () => {
    const parsed = parseCompatible([
      JSON.stringify({ session_id: 'session-1' }),
      JSON.stringify({ message: { text: 'Done.' } }),
      JSON.stringify({ tool_name: 'Edit', command: 'src/App.tsx' }),
    ].join('\n'));
    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.text).toBe('Done.');
    expect(parsed.tools[0]).toMatchObject({ name: 'Edit', detail: 'Edit' });
  });
});
