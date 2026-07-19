import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAllFixtures } from './harness.js';
import { MockComposerClient } from './mockLlm.js';
import { AnthropicLlmClient } from '../src/server/llm/anthropic.js';
import { GOLDEN_FIXTURE_MAP, gradeStyle, readGoldenMeta, readGoldenReferenceBrief } from './styleGrade.js';

/**
 * `npm run evals` — the CI entrypoint (Phase 2 deliverable 7). Gated
 * fields fail the process (exit 1); there is no override flag by design.
 * With ANTHROPIC_API_KEY the fixtures run through the real models; without
 * it, a deterministic mock composer exercises the same pipeline and gates.
 */
async function main() {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const llm = hasKey ? new AnthropicLlmClient() : new MockComposerClient();
  console.log(`eval harness: ${hasKey ? 'REAL models (ANTHROPIC_API_KEY present)' : 'hermetic mode (mock composer; set ANTHROPIC_API_KEY for real prompts)'}`);

  const scores = await runAllFixtures(llm);

  console.log('\nfixture                        verdicts  threads  invented  words/budget  order  voice');
  for (const s of scores) {
    console.log(
      `${s.fixture.padEnd(30)} ${String(s.verdictPreservationPct + '%').padEnd(9)} ${String(s.threadClosurePct + '%').padEnd(8)} ${String(
        s.inventedFactCount,
      ).padEnd(9)} ${`${s.wordCount}/${s.wordBudget}`.padEnd(13)} ${(s.sectionOrderOk ? 'ok' : 'off').padEnd(6)} ${s.voice}`,
    );
  }

  const goldensDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/golden-set');
  const goldens = existsSync(goldensDir) ? readdirSync(goldensDir).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
  const EXPECTED_GOLDENS = ['quiet-day.md', 'storm-day.md', 'mixed-day.md', 'degraded-trust-day.md', 'first-day.md'];
  const missing = EXPECTED_GOLDENS.filter((f) => !goldens.includes(f));
  if (goldens.length === 0) {
    console.log('\nstyle similarity: BLOCKED — golden set missing (docs/golden-set/README.md). Mechanical gates scored above.');
  } else {
    console.log(
      `\nstyle similarity vs goldens (${goldens.length}/5 present${missing.length ? `; awaiting: ${missing.join(', ')}` : ''}) — reported, never gated:`,
    );
    for (const file of Object.keys(GOLDEN_FIXTURE_MAP)) {
      if (!goldens.includes(file)) continue;
      const meta = readGoldenMeta(file)!;
      const fixtureName = GOLDEN_FIXTURE_MAP[file];
      const label = `${file.padEnd(24)} register=${meta.register.padEnd(17)} budget<=${String(meta.budget ?? '?').padEnd(4)}`;
      if (fixtureName === null) {
        console.log(`  ${label} SKIPPED — first-day orientation mode not implemented in the composer yet`);
        continue;
      }
      const score = scores.find((s) => s.fixture === fixtureName);
      if (!score) {
        console.log(`  ${label} no matching fixture ran`);
        continue;
      }
      if (!hasKey) {
        console.log(`  ${label} vs fixture ${fixtureName} — grading requires ANTHROPIC_API_KEY`);
        continue;
      }
      const golden = readGoldenReferenceBrief(file);
      const grade = golden ? await gradeStyle(llm, golden, score.brief) : null;
      console.log(
        grade
          ? `  ${label} vs ${fixtureName}: similarity ${grade.similarity}/10, register ${grade.registerMatch} — ${grade.notes}`
          : `  ${label} grading call failed`,
      );
    }
  }

  const failures = scores.filter((s) => s.gatedFailures.length > 0);
  if (failures.length > 0) {
    console.error('\nGATED FAILURES:');
    for (const f of failures) {
      for (const violation of f.gatedFailures) console.error(`  ${f.fixture}: ${violation}`);
    }
    process.exit(1);
  }
  console.log('\nall gated fields green.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
