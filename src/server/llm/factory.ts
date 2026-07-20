import type { Db } from '../db/client.js';
import { llmEnabled } from './config.js';
import { AnthropicLlmClient } from './anthropic.js';
import { DbNarrationLibrary } from '../narration/library.js';
import type { NarrationDeps } from '../narration/dispatch.js';
import type { ComposeLlmDeps } from '../digest/composeLlm.js';
import type { AskDeps } from '../ask/answer.js';

/** One place that decides whether the voice is on (ANTHROPIC_API_KEY present) and builds the deps. */
export function buildNarrationDeps(db: Db): NarrationDeps | undefined {
  if (!llmEnabled()) return undefined;
  return { llm: new AnthropicLlmClient(), db, library: new DbNarrationLibrary(db) };
}

export function buildComposeDeps(db: Db): ComposeLlmDeps | undefined {
  if (!llmEnabled()) return undefined;
  return { llm: new AnthropicLlmClient(), db };
}

export function buildAskDeps(db: Db): AskDeps | undefined {
  if (!llmEnabled()) return undefined;
  return { llm: new AnthropicLlmClient(), db };
}
