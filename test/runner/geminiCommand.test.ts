import { describe, expect, it } from 'vitest';
import { geminiCommand, geminiInstallCommand, parseGeminiEvents, parseGeminiResult, parseGeminiText } from '../../src/server/runner/workers/geminiCommand.js';
import { driverFor } from '../../src/server/runner/agents/driver.js';
import type { BuilderAuth } from '../../src/server/build/builderAuth.js';

/**
 * The Gemini worker's contract: a turn command that runs headless and
 * unattended, and parsers that read its stream-json defensively — a renamed
 * field must degrade to "cost unknown" or an empty feed, never a crashed turn.
 */

// A plausible stream-json transcript. Field names inside events vary across
// CLI versions, which is exactly why the parsers hunt rather than index.
const LOG = [
  '{"type":"init","session_id":"g-123","model":"gemini-2.5-pro"}',
  'npm warn deprecated something@1.0.0',
  '{"type":"message","role":"assistant","content":"Working on it."}',
  '{"type":"tool_use","id":"call-1","name":"write_file","args":{"file_path":"src/app.ts"}}',
  '{"type":"tool_result","id":"call-1","output":"ok"}',
  '{"type":"tool_use","id":"call-2","name":"run_shell_command","args":{"command":"npm test"}}',
  '{"type":"message","role":"assistant","content":" Done — tests pass."}',
  '{"type":"result","status":"success","stats":{"models":{"gemini-2.5-pro":{"tokens":{"input_tokens":12000,"output_tokens":800}}}}}',
].join('\n');

describe('runner/workers/geminiCommand', () => {
  it('runs headless with auto-approval and the chosen model, prompt shipped by file', () => {
    const command = geminiCommand('build the thing', { model: 'gemini-2.5-pro', mode: 'build' });
    expect(command).toContain('--output-format stream-json');
    expect(command).toContain('--yolo');
    expect(command).toContain('gemini-2.5-pro');
    // The prompt travels base64 → file, never inline where a shell could read meaning into it.
    expect(command).not.toContain('build the thing');
    expect(command).toContain('runuser -u nobody');
  });

  it('installs only when missing, into the shared tools prefix', () => {
    const install = geminiInstallCommand();
    expect(install).toContain('gemini --version >/dev/null 2>&1 ||');
    expect(install).toContain('@google/gemini-cli');
  });

  it('reads the result event: outcome and token totals from a per-model breakdown', () => {
    const result = parseGeminiResult(LOG);
    expect(result.isError).toBe(false);
    expect(result.sessionId).toBe('g-123');
    expect(result.usageReported).toBe(true);
    expect(result.tokensIn).toBe(12000);
    expect(result.tokensOut).toBe(800);
  });

  it('a log with no result event is an error with unknown cost, not a confident zero', () => {
    const result = parseGeminiResult('{"type":"init","session_id":"g-1"}\nsegfault');
    expect(result.isError).toBe(true);
    expect(result.usageReported).toBe(false);
  });

  it('assembles the assistant text from message chunks', () => {
    expect(parseGeminiText(LOG)).toBe('Working on it. Done — tests pass.');
  });

  it('falls back to the result response when no messages streamed', () => {
    expect(parseGeminiText('{"type":"result","response":"All set."}')).toBe('All set.');
  });

  it('turns tool_use events into the activity feed', () => {
    const { tools, truncated } = parseGeminiEvents(LOG);
    expect(truncated).toBe(false);
    expect(tools.map((t) => t.name)).toEqual(['write_file', 'run_shell_command']);
    expect(tools[0]!.detail).toBe('src/app.ts');
    expect(tools[1]!.detail).toBe('npm test');
  });

  it('is the driver an armed gemini-build turn gets', () => {
    const auth: BuilderAuth = {
      agent: 'gemini-build', provider: 'gemini', envVar: 'GEMINI_API_KEY',
      environment: { GEMINI_API_KEY: 'g-key' }, secret: 'g-key', kind: 'api_key', source: 'byo',
    };
    const driver = driverFor('gemini-build', auth);
    expect(driver).not.toBeNull();
    expect(driver!.command('hi', { mode: 'build' })).toContain('gemini');
    // Stateless by design until headless resume lands upstream.
    expect(driver!.result(LOG).costReported).toBe(true);
  });
});
