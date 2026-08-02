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

/**
 * Sketch runs on sonnet, NOT the compose model. The daily brief is one call an
 * org, so it can afford the strongest model; a sketch is a conversation of many
 * turns with a growing transcript, and composeModel() costs several times more
 * per token. Thinking cheaply is the entire point of the room.
 */
export function sketchModel(): string {
  return process.env.SKETCH_MODEL ?? 'claude-sonnet-5';
}

/** Voice is disabled entirely (Phase 1 behavior) when no API key is configured. */
export function llmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
