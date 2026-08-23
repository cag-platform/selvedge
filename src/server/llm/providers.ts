import type { FuelProvider } from '../connectors/registry.js';

/**
 * HOW EACH MODEL PROVIDER IS REACHED — one table, so adding one is a row.
 *
 * The fuel seam always said "adding a provider is a case in `clientFor`, not a
 * new architecture". That was true and it was still two providers, because a
 * case statement with two arms is a table nobody has written down yet. This is
 * the table.
 *
 * WHY THIS IS CHEAP, AND WORTH KNOWING BEFORE READING FURTHER. Every provider
 * below except Anthropic speaks the OpenAI chat-completions protocol at some
 * URL. Moonshot, xAI, DeepSeek, Mistral and Google all publish an
 * OpenAI-compatible endpoint, so "support Kimi" is a base URL and a model name
 * rather than a new client, a new error vocabulary, and a new set of failure
 * modes for the metering to learn. Anthropic keeps its own client because it
 * was here first and its structured-output shape genuinely differs.
 *
 * STRUCTURED OUTPUT IS THE ONE REAL DIFFERENCE, and it is why `structured`
 * exists rather than being assumed. This codebase's LLM seam is
 * structured-output-only: every call sends a JSON Schema and expects JSON back.
 * OpenAI and xAI take a schema directly (`response_format: json_schema`).
 * Others accept only `response_format: {type: 'json_object'}` — valid JSON,
 * shape unenforced — so for those the schema goes into the prompt and the
 * downstream validator does the enforcing it was always doing anyway.
 *
 * WHERE THAT FLAG IS A GUESS, IT GUESSES THE SAFE WAY. `json_object` is
 * supported by every OpenAI-compatible endpoint; `json_schema` is not, and
 * sending it where it isn't supported fails the whole request rather than
 * degrading. So a provider whose support has not been confirmed against the
 * live API is set to `json_object` here. Confirming one and flipping it is a
 * one-word change, and the wrong direction costs a broken provider rather than
 * a slightly looser response.
 */

export type StructuredMode = 'json_schema' | 'json_object';

export type ProviderWiring = {
  /** What a person calls it, in the connect UI and in a refusal. */
  label: string;
  /**
   * The OpenAI-compatible endpoint. Null means this provider has a client of
   * its own (Anthropic) or is the OpenAI SDK's own default (OpenAI).
   */
  baseUrl: string | null;
  /** The platform's own key, for a deployment running managed fuel. */
  envVar: string;
  /** What a chat turn runs on here, unless the environment overrides it. */
  chatModel: string;
  /** The variable that overrides `chatModel`, for pinning or rolling back. */
  chatModelEnv: string;
  /** How this endpoint takes a JSON Schema. See the note above. */
  structured: StructuredMode;
};

export const PROVIDER_WIRING: Record<FuelProvider, ProviderWiring> = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: null,
    envVar: 'ANTHROPIC_API_KEY',
    chatModel: 'claude-sonnet-5',
    chatModelEnv: 'CHAT_MODEL',
    structured: 'json_schema',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: null,
    envVar: 'OPENAI_API_KEY',
    chatModel: 'gpt-5.6-terra',
    chatModelEnv: 'CHAT_MODEL_OPENAI',
    structured: 'json_schema',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    envVar: 'GEMINI_API_KEY',
    chatModel: 'gemini-2.5-pro',
    chatModelEnv: 'CHAT_MODEL_GEMINI',
    structured: 'json_object',
  },
  kimi: {
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    envVar: 'KIMI_API_KEY',
    chatModel: 'kimi-k2-0905-preview',
    chatModelEnv: 'CHAT_MODEL_KIMI',
    structured: 'json_object',
  },
  xai: {
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    envVar: 'XAI_API_KEY',
    chatModel: 'grok-4',
    chatModelEnv: 'CHAT_MODEL_XAI',
    structured: 'json_object',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envVar: 'DEEPSEEK_API_KEY',
    chatModel: 'deepseek-chat',
    chatModelEnv: 'CHAT_MODEL_DEEPSEEK',
    structured: 'json_object',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
    chatModel: 'mistral-large-latest',
    chatModelEnv: 'CHAT_MODEL_MISTRAL',
    structured: 'json_object',
  },
};

export function wiringFor(provider: FuelProvider): ProviderWiring {
  return PROVIDER_WIRING[provider];
}

/** The platform's own key for a provider, when the deployment carries one. */
export function platformKeyFor(provider: FuelProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[PROVIDER_WIRING[provider].envVar]?.trim() || undefined;
}

/**
 * What a chat turn runs on. The environment override exists so a model can be
 * pinned or rolled back without a deploy of this file.
 */
export function chatModelFor(provider: FuelProvider, env: NodeJS.ProcessEnv = process.env): string {
  const wiring = PROVIDER_WIRING[provider];
  return env[wiring.chatModelEnv]?.trim() || wiring.chatModel;
}
