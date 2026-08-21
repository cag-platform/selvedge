/**
 * The narrow LLM-client seam. Everything above this interface (narration
 * dispatch, composer, evals) is testable with a fake; only anthropic.ts
 * touches the network. One request shape, structured-output-only — Phase 2
 * has no free-text LLM surface at all, which is what makes the validator
 * and evals mechanically checkable.
 */

/**
 * What a model call was FOR. Load-bearing for the ledger and for the budget
 * split: purposes are what `checkDailyBudget` filters on, so a new one that
 * nobody carves out is silently swept into the daily brief's allowance.
 *
 * 'chat' is a general thread's turn — the Inbox's plain conversation, no
 * sandbox, nothing to ship. It inherits retired Sketch's side of the split for
 * exactly Sketch's reason: it is the chattiest surface in the product, and an
 * afternoon of thinking must never turn tomorrow morning's brief mechanical.
 */
export type LlmPurpose = 'fragment' | 'compose' | 'gist' | 'sketch' | 'grade' | 'chat';

export type LlmRequest = {
  model: string;
  system: string;
  userContent: string;
  maxTokens: number;
  /** JSON Schema the response must conform to (structured outputs). */
  schema: Record<string, unknown>;
};

/**
 * Who served the call. Optional: a client that knows its own provider should
 * say so, and metering falls back to looking the model id up in the pricing
 * table when it doesn't. Kept optional deliberately — making it required would
 * force every test fake to declare a provider it doesn't have an opinion about.
 */
export type LlmProvider = string;

export type LlmSuccess = {
  ok: true;
  /** Parsed structured output. */
  json: unknown;
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider?: LlmProvider;
};

export type LlmFailure = {
  ok: false;
  /** Why the call failed: timeout, refusal, invalid-json, api-error... Recorded with the fallback. */
  reason: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider?: LlmProvider;
};

export type LlmResult = LlmSuccess | LlmFailure;

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}
