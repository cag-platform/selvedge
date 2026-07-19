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
