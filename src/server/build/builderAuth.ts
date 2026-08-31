import type { Db } from '../db/client.js';
import { credentialPresence, useCredentialWithKind, type CredentialKind } from '../connectors/credentials/store.js';
import { agentById, type AgentId, type AgentProvider } from '../../shared/agents.js';

/**
 * WHOSE ACCOUNT THE BUILDER RUNS ON — one answer, for every agent that builds.
 *
 * THE BUG THIS CLOSES, WHICH THIS CODEBASE HAS NOW FOUND THREE TIMES. One job,
 * two identities: a surface asks the org who they are, and the thing that does
 * the work quietly uses the platform's credentials instead. GitHub had it and
 * repoToken.ts fixed it. OpenAI had it and openaiKey.ts fixed it — its header
 * describes the shape exactly. Claude Code still had it: `engineEnv()` read
 * `CLAUDE_CODE_OAUTH_TOKEN` out of `process.env` with no org in scope, so every
 * build turn for every customer who would ever sign up ran on ONE account's
 * Claude subscription.
 *
 * That is not only a bill in the wrong place. A subscription is rate-limited
 * per account, so the tenth org to start a build does not get a larger invoice,
 * it gets a failure — and the failure lands on a customer who did nothing
 * wrong and cannot fix it from their side.
 *
 * So this module exists once, and every builder goes through it. Adding a
 * third builder means a row in the table below, not another corner for the same
 * bug to appear in.
 *
 * THE KIND IS LOAD-BEARING, WHICH IS WHY IT IS RESOLVED HERE AND NOT GUESSED.
 * The Claude Code CLI authenticates two ways and reads a DIFFERENT environment
 * variable for each: a subscription token (what `claude setup-token` prints)
 * from CLAUDE_CODE_OAUTH_TOKEN, an API key from ANTHROPIC_API_KEY. Put a secret
 * in the wrong one and nothing says so — the CLI simply doesn't find
 * credentials, deep inside a sandbox the owner has already been metered for.
 * The vault has recorded `kind` since it was written; this is the first thing
 * to read it, which is why `useCredentialWithKind` had to exist.
 *
 * RESOLUTION ORDER — the same one the fuel seam and the repo token already use,
 * because a fourth order would be a fourth thing to be surprised by:
 *   1. The org's own connected credential. This is the product.
 *   2. The platform's, when this deployment offers managed fuel. Visible in
 *      `source`, never silent, and switchable off with MANAGED_FUEL=off.
 *   3. Nothing — and a sentence saying which credential to connect, because a
 *      builder that can't run is a fact the owner can act on, not an error.
 */

export type BuilderAgentId = Extract<AgentId, 'claude-code' | 'codex' | 'kimi-code' | 'grok-build' | 'deepseek-build'>;

export type BuilderAuth = {
  agent: BuilderAgentId;
  provider: AgentProvider;
  /** The variable this CLI reads the secret from. Decided by `kind`, never assumed. */
  envVar: string;
  /** Complete command-scoped environment. Some CLIs use a compatibility name. */
  environment: Record<string, string>;
  secret: string;
  kind: CredentialKind;
  /** 'byo' = the org's own credential; 'managed' = this deployment covering it. */
  source: 'byo' | 'managed';
};

export type BuilderAuthResult = { ok: true; auth: BuilderAuth } | { ok: false; note: string };

type PlatformSource = { envVar: string; kind: CredentialKind };

type BuilderWiring = {
  provider: AgentProvider;
  /**
   * Where a secret of each kind goes. A kind absent from this map is a way this
   * CLI cannot be authenticated, and is refused by name rather than attempted.
   */
  envVarByKind: Partial<Record<CredentialKind, string>>;
  /**
   * The deployment's own credentials, best first. Two entries for Anthropic
   * because a deployment may hold either, and the CLI takes either.
   */
  platform: PlatformSource[];
  /** What to connect, in the owner's words, when there is nothing. */
  connectNote: string;
  /** What to say when the credential they connected is the wrong sort for this CLI. */
  wrongKindNote: string;
  commandEnv?: (secret: string, envVar: string) => Record<string, string>;
};

/**
 * ONE ROW PER BUILDER. Note that `provider` matches the agent table's — the
 * provider ids are encryption-bound (an AES-GCM AAD component), so these
 * strings may be added to but never renamed.
 */
const BUILDER_WIRING: Record<BuilderAgentId, BuilderWiring> = {
  'claude-code': {
    provider: 'anthropic',
    envVarByKind: {
      subscription: 'CLAUDE_CODE_OAUTH_TOKEN',
      api_key: 'ANTHROPIC_API_KEY',
    },
    // Subscription first: an owner who has both would rather spend the seat
    // they have already paid for than meter tokens.
    platform: [
      { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'subscription' },
      { envVar: 'ANTHROPIC_API_KEY', kind: 'api_key' },
    ],
    connectNote:
      'Claude Code builds on your own Anthropic account. Connect an API key, or a Claude subscription token from `claude setup-token`, under Connections.',
    wrongKindNote: '',
  },
  codex: {
    provider: 'openai',
    envVarByKind: {
      api_key: 'OPENAI_API_KEY',
    },
    platform: [{ envVar: 'OPENAI_API_KEY', kind: 'api_key' }],
    connectNote: 'Codex builds on an OpenAI API key. Add one under Connections and it can build here.',
    // Said plainly rather than tried and failed. The Codex CLI signs in to a
    // ChatGPT subscription through its own login flow, which writes a file
    // inside the machine it ran on — not something a pasted token reproduces
    // in a fresh sandbox. Handing it a subscription token as if it were a key
    // buys an auth error on a metered minute, so it is refused here instead.
    wrongKindNote:
      'Codex needs an OpenAI API key — it can’t build on a ChatGPT subscription. Connect an API key under Connections and it can build here.',
  },
  'kimi-code': {
    provider: 'kimi', envVarByKind: { api_key: 'KIMI_API_KEY' }, platform: [{ envVar: 'KIMI_API_KEY', kind: 'api_key' }],
    connectNote: 'Kimi Code builds on a Moonshot API key. Add one under Connections and it can build here.', wrongKindNote: '',
    commandEnv: (secret) => ({ KIMI_API_KEY: secret, KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_MODEL_PROVIDER_TYPE: 'kimi', KIMI_MODEL_API_KEY: secret, KIMI_MODEL_BASE_URL: 'https://api.moonshot.ai/v1', KIMI_MODEL_MAX_CONTEXT_SIZE: '262144' }),
  },
  'grok-build': {
    provider: 'xai', envVarByKind: { api_key: 'XAI_API_KEY' }, platform: [{ envVar: 'XAI_API_KEY', kind: 'api_key' }],
    connectNote: 'Grok Build builds on an xAI API key. Add one under Connections and it can build here.', wrongKindNote: '',
  },
  'deepseek-build': {
    provider: 'deepseek', envVarByKind: { api_key: 'DEEPSEEK_API_KEY' }, platform: [{ envVar: 'DEEPSEEK_API_KEY', kind: 'api_key' }],
    connectNote: 'DeepSeek Build builds on a DeepSeek API key. Add one under Connections and it can build here.', wrongKindNote: '',
    commandEnv: (secret) => ({ DEEPSEEK_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }),
  },
};

export function isBuilderAgent(agent: AgentId): agent is BuilderAgentId {
  return agent in BUILDER_WIRING;
}

/**
 * Does this deployment cover builds for orgs that haven't connected anything?
 *
 * Default ON, because that is what was running before this module existed and
 * a deploy is the wrong moment to discover a policy change. `MANAGED_FUEL=off`
 * turns it off, which is the switch to reach for the day BYO is the promise
 * rather than the default — every org then builds on its own account or is told
 * plainly that it needs to connect one.
 */
export function managedFuelAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MANAGED_FUEL ?? '').trim().toLowerCase() !== 'off';
}

export type BuilderAuthDeps = {
  env?: NodeJS.ProcessEnv;
};

/**
 * The credential this org's build turn should run on, or a sentence saying why
 * it can't run — never a silent fall through to somebody else's account.
 */
export async function resolveBuilderAuth(
  db: Db,
  orgId: string,
  agent: AgentId,
  deps: BuilderAuthDeps = {},
): Promise<BuilderAuthResult> {
  if (!isBuilderAgent(agent)) {
    const name = agentById(agent)?.name ?? agent;
    return { ok: false, note: `${name} doesn’t build — it answers in the thread without touching your files.` };
  }

  const wiring = BUILDER_WIRING[agent];
  const env = deps.env ?? process.env;

  const connected = await useCredentialWithKind(db, orgId, wiring.provider).catch(() => null);
  if (connected?.secret.trim()) {
    const envVar = wiring.envVarByKind[connected.kind];
    // A credential of a kind this CLI can't use is a refusal with a fix in it,
    // not a fallback to the platform's account. Falling back here would spend
    // the deployment's money on behalf of an org that has connected their own
    // and would never find out why the bill didn't move.
    if (!envVar) return { ok: false, note: wiring.wrongKindNote || wiring.connectNote };
    return {
      ok: true,
      auth: {
        agent,
        provider: wiring.provider,
        envVar,
        environment: wiring.commandEnv ? wiring.commandEnv(connected.secret.trim(), envVar) : { [envVar]: connected.secret.trim() },
        secret: connected.secret.trim(),
        kind: connected.kind,
        source: 'byo',
      },
    };
  }

  if (managedFuelAllowed(env)) {
    for (const candidate of wiring.platform) {
      const secret = env[candidate.envVar]?.trim();
      if (secret) {
        return {
          ok: true,
          auth: {
            agent,
            provider: wiring.provider,
            envVar: candidate.envVar,
            environment: wiring.commandEnv ? wiring.commandEnv(secret, candidate.envVar) : { [candidate.envVar]: secret },
            secret,
            kind: candidate.kind,
            source: 'managed',
          },
        };
      }
    }
  }

  return { ok: false, note: wiring.connectNote };
}

/**
 * Could this builder run for this org — without decrypting anything?
 *
 * The roster's question. It has to give the SAME answer `resolveBuilderAuth`
 * would, which is why it reads the same table and the same kind rather than
 * checking for the mere existence of a row: a connected credential of the wrong
 * sort is exactly the case where "you have a key, so you're fine" is a lie the
 * owner only discovers by spending a minute.
 */
export async function builderAvailability(
  db: Db,
  orgId: string,
  agent: AgentId,
  deps: BuilderAuthDeps = {},
): Promise<{ available: boolean; note: string | null }> {
  if (!isBuilderAgent(agent)) return { available: false, note: null };

  const wiring = BUILDER_WIRING[agent];
  const env = deps.env ?? process.env;

  const present = await credentialPresence(db, orgId, wiring.provider).catch(() => null);
  if (present) {
    if (!wiring.envVarByKind[present.kind]) {
      return { available: false, note: wiring.wrongKindNote || wiring.connectNote };
    }
    return { available: true, note: null };
  }

  if (managedFuelAllowed(env) && wiring.platform.some((c) => env[c.envVar]?.trim())) {
    return { available: true, note: null };
  }

  return { available: false, note: wiring.connectNote };
}

/** The providers a builder can be authenticated with — for tests and the connect UI. */
export function builderProviders(): AgentProvider[] {
  return [...new Set(Object.values(BUILDER_WIRING).map((w) => w.provider))];
}

/** Which kinds of credential a builder's provider actually accepts, for the connect copy. */
export function acceptedKinds(agent: BuilderAgentId): CredentialKind[] {
  return Object.keys(BUILDER_WIRING[agent].envVarByKind) as CredentialKind[];
}
