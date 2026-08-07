/**
 * Sanity-check the independent grader in 30 seconds, no sandbox run required.
 *
 *   OPENAI_API_KEY=sk-... npx tsx scripts/grade-once.ts
 *
 * Runs the REAL grader prompt on the REAL OpenAI client against two built-in
 * fixtures — one diff that does what its ask says (expect pass) and one that
 * doesn't (expect fail) — and prints the model's JSON answers. This is the
 * miniature Phase 1 gate: if the mismatched fixture doesn't fail, the grader
 * model is too lenient — try EVAL_MODEL=gpt-5.6-terra.
 *
 * Or grade your own case:
 *   npx tsx scripts/grade-once.ts "the ask" path/to/diff.txt
 *
 * Costs a fraction of a cent per call. Nothing touches the database — usage
 * metering and budgets are exercised by the product path, not this probe.
 */
import { readFileSync } from 'node:fs';
import { OpenAiLlmClient } from '../src/server/llm/openai.js';
import { GRADE_SCHEMA } from '../src/server/verify/grader.js';
import { evalModel } from '../src/server/llm/config.js';

const FIXTURES = [
  {
    name: 'a change that DOES what was asked (expect pass)',
    ask: 'Make the gift note field optional at checkout',
    evidence: [
      'Files changed (1):',
      '  src/pages/Checkout.tsx',
      '',
      '--- src/pages/Checkout.tsx',
      '@@ -41,8 +41,7 @@',
      '   <label htmlFor="gift-note">Gift note</label>',
      '-  <textarea id="gift-note" required value={note} onChange={...} />',
      '-  {noteError && <p className="error">A gift note is required.</p>}',
      '+  <textarea id="gift-note" value={note} onChange={...} placeholder="Optional" />',
      '@@ -78,3 +77,2 @@',
      '   function validate() {',
      '-    if (!note.trim()) return { ok: false, field: "gift-note" };',
      '     if (!email.trim()) return { ok: false, field: "email" };',
    ].join('\n'),
  },
  {
    name: 'a change that does NOT do what was asked (expect fail)',
    ask: 'Remove the newsletter signup from every page',
    evidence: [
      'Files changed (1):',
      '  src/components/Footer.tsx',
      '',
      '--- src/components/Footer.tsx',
      '@@ -12,7 +12,7 @@',
      '-  <NewsletterSignup />',
      '+  {/* <NewsletterSignup /> */}',
      '',
      '(the signup also renders in src/pages/Home.tsx and src/components/Sidebar.tsx — unchanged)',
    ].join('\n'),
  },
];

async function main() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    console.error('OPENAI_API_KEY is not set — that key is the grader\'s on-switch, here and in the product.');
    process.exit(1);
  }
  const model = evalModel();
  const llm = new OpenAiLlmClient(key);
  console.log(`grader model: ${model}\n`);

  const [askArg, diffPath] = process.argv.slice(2);
  const cases = askArg && diffPath
    ? [{ name: 'your case', ask: askArg, evidence: readFileSync(diffPath, 'utf-8') }]
    : FIXTURES;

  // The same prompt file the product uses, same header strip.
  const system = readFileSync(new URL('../config/prompts/grader-system.md', import.meta.url), 'utf-8')
    .replace(/^<!--[\s\S]*?-->\s*/, '');

  for (const c of cases) {
    console.log(`── ${c.name}`);
    const result = await llm.complete({
      model,
      system,
      userContent: `What was asked:\n${c.ask}\n\nWhat changed:\n${c.evidence}`,
      maxTokens: 500,
      schema: GRADE_SCHEMA as unknown as Record<string, unknown>,
    });
    if (!result.ok) {
      console.log(`   the call failed: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}\n`);
      continue;
    }
    console.log(`   ${JSON.stringify(result.json)}`);
    console.log(`   (${result.tokensIn} tokens in, ${result.tokensOut} out)\n`);
  }
}

void main();
