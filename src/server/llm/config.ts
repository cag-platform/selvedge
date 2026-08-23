import { chatModelFor } from './providers.js';
import type { FuelProvider } from '../connectors/registry.js';

/**
 * Models come from config, not code (Phase 2 brief, deliverable 2).
 * Defaults per the brief: current Sonnet for fragments, current strongest
 * model for the daily composition call.
 */
export function narrateModel(): string {
  return process.env.NARRATE_MODEL ?? 'claude-sonnet-5';
}

export function composeModel(): string {
  return process.env.COMPOSE_MODEL ?? 'claude-fable-5';
}

/** Voice is disabled entirely (Phase 1 behavior) when no API key is configured. */
export function llmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The model that GRADES a change — never the one that writes it. Reads
 * EVAL_MODEL and only EVAL_MODEL, the mirror of agentModelFromEnv's guarantee
 * (runner/daytona/factory.ts) that the author never reads the grader's knob.
 * These two variables crossing is how a grader ends up grading its own work,
 * which is the one failure the whole verifier exists to prevent.
 *
 * Default: gpt-5.6-luna — priced in config/model-pricing.json; a grade reads a
 * bounded diff and answers in a sentence, which luna does for a fraction of a
 * cent. The grader itself is gated on OPENAI_API_KEY being set (llm/factory.ts),
 * so this default never causes a call on an unconfigured deploy.
 */
export function evalModel(): string {
  return process.env.EVAL_MODEL ?? 'gpt-5.6-luna';
}

/**
 * The model behind a general thread. Sonnet-class on either provider: a
 * thinking conversation wants a good model, not the strongest and most
 * expensive one — the brief's composition call is where fable earns its price.
 * Both ids are priced in config/model-pricing.json, so a chat turn's spend is
 * counted rather than estimated at the fallback rate.
 */
export function chatModel(provider: FuelProvider): string {
  // One table (llm/providers.ts) rather than a chain of ifs that has to grow a
  // link every time an agent is added.
  return chatModelFor(provider);
}
