/**
 * The narrow LLM-client seam. Everything above this interface (narration
 * dispatch, composer, evals) is testable with a fake; only anthropic.ts
 * touches the network. One request shape, structured-output-only — Phase 2
 * has no free-text LLM surface at all, which is what makes the validator
 * and evals mechanically checkable.
 */

export type LlmPurpose = 'fragment' | 'compose' | 'gist' | 'sketch';

export type LlmRequest = {
  model: string;
  system: string;
  userContent: string;
  maxTokens: number;
  /** JSON Schema the response must conform to (structured outputs). */
  schema: Record<string, unknown>;
};

export type LlmSuccess = {
  ok: true;
  /** Parsed structured output. */
  json: unknown;
  tokensIn: number;
  tokensOut: number;
  model: string;
};

export type LlmFailure = {
  ok: false;
  /** Why the call failed: timeout, refusal, invalid-json, api-error... Recorded with the fallback. */
  reason: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
};

export type LlmResult = LlmSuccess | LlmFailure;

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}
