/**
 * THE SUITE READS NO ENVIRONMENT IT DID NOT SET ITSELF.
 *
 * This exists because of a failure that is much worse than the bug it fixed:
 * twenty-three tests passed on a developer's machine and failed in CI, for
 * months, and the difference was not the code. It was that the developer's
 * shell had GITHUB_TOKEN exported and CI's did not — so `resolveRepoToken`
 * found a static token locally and refused with a 409 in CI, and every route
 * test that starts a build turn quietly took a different path depending on who
 * ran it.
 *
 * A test whose result depends on what you happen to have exported is not a
 * test. It is worse than no test: it is a green tick that means "this passed
 * somewhere", and the day it goes red nobody can tell whether the code broke or
 * the laptop changed.
 *
 * So every ambient credential this codebase reads is neutralised here, before
 * any test file loads, and the handful the suite genuinely needs are set to
 * fixed, obviously-fake values. Local and CI now run the same program.
 *
 * A test that wants one of these present or absent still says so itself — this
 * only decides what happens when nobody said.
 */

/**
 * Cleared, not set. Each of these switches a code path when present, and the
 * paths they switch are ones individual tests turn on deliberately: the build
 * engine (CLAUDE_CODE_OAUTH_TOKEN + DAYTONA_API_KEY), model fuel, billing.
 * Leaving a developer's real key in the environment would let it decide.
 */
const AMBIENT = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DAYTONA_API_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_YEARLY',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'DATABASE_URL',
];

for (const name of AMBIENT) delete process.env[name];

/**
 * Set, because the suite needs it to be one specific thing rather than absent.
 *
 * A route that starts a build turn resolves a credential for the repo first —
 * deliberately, so a repo we cannot reach is a refusal rather than a sandbox
 * started and a minute billed. With no GitHub App configured, that resolution
 * falls back to this static token, which is exactly the path a self-hosted
 * deployment without the App takes. Every one of those tests is about what
 * happens AFTER the credential resolves, so this is the setting that lets them
 * be about their subject.
 *
 * Tests that are about the credential itself clear or override it.
 */
process.env.GITHUB_TOKEN = 'ghp_test_token_not_a_real_credential';

/** Fixed so a test never depends on the machine's timezone. */
process.env.TZ = 'UTC';
