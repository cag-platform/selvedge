import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * THE RULE, HELD STRUCTURALLY RATHER THAN BY REMEMBERING IT.
 *
 * This codebase has now shipped the same bug three times — GitHub, then OpenAI,
 * then Claude Code — and each time the fix was a module and a test about that
 * one credential. The fourth builder would have got it too, because nothing
 * stopped it: reading `process.env.SOMETHING_API_KEY` inside a build path looks
 * completely ordinary at review, and the consequence (one account paying for
 * every customer, and one account's rate limit shared by strangers) doesn't
 * show up until there are customers.
 *
 * So the rule is enforced against the source itself, the same way
 * `test/db/tenancy.test.ts` enforces org-scoping against the real schema
 * objects: NOTHING THAT RUNS AN AGENT MAY READ A MODEL CREDENTIAL WITHOUT AN
 * ORG IN SCOPE. An exception needs a line in this file with a reason, which is
 * a deliberately annoying thing to have to write.
 */

/** Every variable that is somebody's money. */
const MODEL_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
];

/** Where agents are started. If a file here reads a credential, a customer is paying for the wrong thing. */
const AGENT_PATHS = ['src/server/build', 'src/server/runner', 'src/server/chat', 'src/server/threads'];

/**
 * The written-down exceptions. Both are platform-scoped ON PURPOSE and neither
 * runs a customer's agent.
 */
const ALLOWED = new Map<string, string>([
  [
    'src/server/llm/factory.ts',
    'the independent grader — platform-scoped by construction so a customer key can never mark its own homework',
  ],
  ['src/server/llm/config.ts', 'a boolean "is a platform key configured at all", used for a capability line, never to spend'],
]);

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no agent path spends money without knowing whose it is', () => {
  it('reads no model credential straight out of the environment', async () => {
    const files = (await Promise.all(AGENT_PATHS.map((d) => tsFilesUnder(d)))).flat();
    // A guard against the guard: if the paths ever stop matching real
    // directories, this test would pass by finding nothing at all.
    expect(files.length).toBeGreaterThan(20);

    const offences: string[] = [];
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const source = await readFile(file, 'utf8');
      for (const credential of MODEL_CREDENTIALS) {
        // `process.env.X` and `process.env['X']` and `env.X` off a captured
        // process.env all read the same way to a reviewer and to a bill.
        const pattern = new RegExp(`process\\.env(\\.${credential}\\b|\\[['"\`]${credential}['"\`]\\])`);
        if (pattern.test(source)) offences.push(`${file} reads ${credential}`);
      }
    }

    expect(offences).toEqual([]);
  });

  /**
   * The credential names still have to appear somewhere — they ARE the
   * variables the CLIs read. What must not happen again is a second place
   * WIRING one: a shell assignment baked into a command, or a key on an object
   * handed to a sandbox. Both are how the token got into a sandbox's
   * environment in the first place.
   *
   * Prose is left alone deliberately. Several files explain this history by
   * name, and a test that forced those comments to be vague about which
   * variable it was would make the record worse to save nothing.
   */
  it('wires the builders’ variables in exactly one table', async () => {
    const builderAuth = await readFile('src/server/build/builderAuth.ts', 'utf8');
    expect(builderAuth).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(builderAuth).toContain('ANTHROPIC_API_KEY');

    const others = (await Promise.all(AGENT_PATHS.map((d) => tsFilesUnder(d))))
      .flat()
      .filter((f) => f !== 'src/server/build/builderAuth.ts');

    const wired: string[] = [];
    for (const file of others) {
      const source = await readFile(file, 'utf8');
      for (const credential of MODEL_CREDENTIALS) {
        // `FOO=` (a shell prefix) or `FOO:` (an object key). Prose says the
        // name and then stops.
        if (new RegExp(`\\b${credential}\\s*[:=]`).test(source)) wired.push(`${file} wires ${credential}`);
      }
    }
    expect(wired).toEqual([]);
  });
});
