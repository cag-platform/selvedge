/**
 * The credential contract, in one place. Every secret and config value the
 * server consumes is enumerated here, grouped by the feature it powers, so a
 * deploy knows exactly what to set — and so the process refuses to boot when a
 * boot-critical credential is missing rather than failing obscurely later.
 *
 * Nothing here holds a value; it holds the SHAPE of what's needed. Values come
 * from the environment (deploy-time config) or, for per-org secrets like model
 * keys and host tokens, from the encrypted vault via the connect UI — never from
 * source, never from a log. `describeConfig` reports only whether each feature is
 * configured (booleans), never a secret.
 */

export type FeatureKind = 'boot' | 'auth' | 'feature';

export type FeatureSpec = {
  key: string;
  label: string;
  kind: FeatureKind;
  /** All env vars this feature needs to be fully on. */
  vars: string[];
  /** Plain line: what turning this on gives you. */
  gives: string;
};

export const FEATURES: FeatureSpec[] = [
  { key: 'database', label: 'Database', kind: 'boot', vars: ['DATABASE_URL'], gives: 'the app cannot run without its database' },
  // The vault degrades gracefully — the crypto layer fails closed when USED
  // without a key, so the app still boots and watches; only storing/reading a
  // credential fails. Deliberately NOT boot-fatal, so setting this key later on
  // an existing deploy never has to mean a crash-loop in the meantime.
  { key: 'vault', label: 'Credential vault', kind: 'auth', vars: ['CREDENTIALS_KEY'], gives: 'encrypts every stored model key and host token; without it, connecting a key or token fails until it is set (watching still works)' },
  { key: 'auth', label: 'Sign-in', kind: 'auth', vars: ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'], gives: 'the /api is 503 until sign-in is configured' },
  { key: 'platform_voice', label: 'Platform voice (fallback fuel)', kind: 'feature', vars: ['ANTHROPIC_API_KEY'], gives: 'a shared model key for orgs that have not brought their own; without it, no-fuel orgs get the plain mechanical brief' },
  { key: 'github_app', label: 'GitHub App (watch repos)', kind: 'feature', vars: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_SLUG', 'GITHUB_WEBHOOK_SECRET'], gives: 'receiving code/build events and reading repos' },
  { key: 'github_oauth', label: 'GitHub OAuth (borrow-and-return)', kind: 'feature', vars: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_OAUTH_REDIRECT_URI'], gives: 'the in-app repo setup flow for migrations' },
  { key: 'railway_oauth', label: 'Login with Railway', kind: 'feature', vars: ['RAILWAY_OAUTH_CLIENT_ID', 'RAILWAY_OAUTH_CLIENT_SECRET', 'RAILWAY_OAUTH_REDIRECT_URI'], gives: 'one-click hosting sign-in instead of hunting for a token; without it the paste-a-token path still works, but a pasted token never renews itself' },
  // Distinct from the boot 'Database' feature above: that one is Selvedge's own
  // Postgres, this one creates databases for the customer's apps at go-live.
  { key: 'app_databases', label: 'Neon (databases for apps you put online)', kind: 'feature', vars: ['NEON_API_KEY'], gives: 'creating a database for an app that declares one in its .env.example; without it, go-live says plainly that it cannot' },
  { key: 'push', label: 'Push notifications', kind: 'feature', vars: ['APNS_AUTH_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'], gives: 'critical alerts on the owner’s phone; without it they still fold into the brief' },
  // GITHUB_TOKEN is deliberately absent: reaching a repo is answered per org
  // from the GitHub App installation above, so a deployment-wide token is
  // neither required nor sufficient. It survives only as an optional fallback
  // for deployments with no app, and for creating a repo from nothing.
  { key: 'agent', label: 'Build engine (agent + sandbox)', kind: 'feature', vars: ['DAYTONA_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], gives: 'the part that actually makes an approved change: a Daytona sandbox and the Claude Code agent. Cloning and pushing use the org’s own GitHub App installation' },
  // Gated on the KEY, not the model name: EVAL_MODEL has a safe default
  // (gpt-5.6-luna) and lives in OPTIONAL_VARS as a tuning knob. Listing it here
  // would report `partial` for a deploy that set the key and sensibly left the
  // model alone, which would be false.
  { key: 'evaluator', label: 'Independent grader (the verified verdict)', kind: 'feature', vars: ['OPENAI_API_KEY'], gives: 'judges "did it do what was asked" on a different provider than authored the change, so a verdict never grades its own work; without it, verdicts top out at `probably` — never a false verified' },
  // The same key, a second job: the Inbox's second builder. Separate row
  // because they are separate promises — grading independence does not depend
  // on Codex existing, and Codex not running does not weaken a verdict.
  { key: 'codex', label: 'Codex, the second builder', kind: 'feature', vars: ['OPENAI_API_KEY', 'DAYTONA_API_KEY'], gives: 'lets a workshop thread switch builders mid-task — Codex runs in the same sandbox and starts from the handoff; without it the switcher says plainly that Codex is not switched on here' },
];

/** Tuning knobs that have safe defaults — never required, listed for completeness. */
export const OPTIONAL_VARS = ['PORT', 'NODE_ENV', 'DAILY_LLM_BUDGET_USD', 'GRADE_DAILY_BUDGET_USD', 'THINKING_DAILY_BUDGET_USD', 'NARRATE_MODEL', 'COMPOSE_MODEL', 'AGENT_MODEL', 'EVAL_MODEL', 'CHAT_MODEL', 'CHAT_MODEL_OPENAI', 'CODEX_MODEL', 'SEED_ORG_ID', 'PREVIEW_DOMAIN', 'GITHUB_ORG'];

export type FeatureStatus = { key: string; label: string; kind: FeatureKind; status: 'on' | 'off' | 'partial'; missing: string[]; gives: string };

function statusOf(spec: FeatureSpec, env: NodeJS.ProcessEnv): FeatureStatus {
  const present = spec.vars.filter((v) => (env[v] ?? '').trim() !== '');
  const missing = spec.vars.filter((v) => (env[v] ?? '').trim() === '');
  const status = missing.length === 0 ? 'on' : present.length === 0 ? 'off' : 'partial';
  return { key: spec.key, label: spec.label, kind: spec.kind, status, missing, gives: spec.gives };
}

export type EnvReport = {
  ok: boolean; // every boot feature is fully configured
  features: FeatureStatus[];
};

/** Validate the environment. `ok` is false only when a boot-critical credential is missing. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const features = FEATURES.map((f) => statusOf(f, env));
  const bootBroken = features.some((f) => f.kind === 'boot' && f.status !== 'on');
  return { ok: !bootBroken, features };
}

/** Configured-or-not for each feature, safe to expose (no secrets). */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  return Object.fromEntries(validateEnv(env).features.map((f) => [f.key, f.status === 'on']));
}

/** Plain lines summarizing the environment, for the boot log. */
export function envReportLines(report: EnvReport): string[] {
  const lines: string[] = [];
  for (const f of report.features) {
    if (f.status === 'on') continue;
    const tag = f.kind === 'boot' ? 'MISSING (required to boot)' : f.status === 'partial' ? 'PARTIAL' : 'off';
    lines.push(`  · ${f.label}: ${tag} — set ${f.missing.join(', ')} (${f.gives})`);
  }
  return lines;
}
