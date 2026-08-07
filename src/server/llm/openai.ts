import OpenAI from 'openai';
import type { LlmClient, LlmRequest, LlmResult } from './types.js';

const TIMEOUT_MS = 60_000;
/** Stamped on every result so spend attributes to a provider, not just a model id. */
const PROVIDER = 'openai';

/**
 * The second provider — and the second file in this codebase that touches a
 * model over the network.
 *
 * It exists for one reason: a change graded by the same model that wrote it is
 * not independently graded. The whole position ("the tool that built your app
 * can't honestly report on it") only holds if the grader has a different
 * lineage from the author, so the point of this file is *difference*, not
 * choice. It is not offered as BYO fuel — see routes/fuel.ts.
 *
 * Implements the same one-method seam as anthropic.ts. Three real differences,
 * all contained here:
 *   1. The system prompt is a message, not a top-level parameter.
 *   2. Structured output is `response_format: json_schema` rather than
 *      `output_config.format` — and strict mode is conditional, see below.
 *   3. A refusal arrives as a `refusal` field on the message, not a stop
 *      reason. It is a failed call for our purposes either way, so it maps onto
 *      the same `LlmFailure.reason` vocabulary anthropic.ts uses; the callers
 *      above this seam must not be able to tell which provider failed.
 *
 * Deliberately NOT ported: Anthropic's server-side fallback branch. That is
 * genuinely provider-specific, and a grader that silently falls back to a
 * second model would undermine the one property this file exists to provide.
 */
export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      timeout: TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: req.model,
        // Newer models reject max_tokens; max_completion_tokens is the
        // supported spelling and means the same thing to this seam.
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.userContent },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'selvedge_response', schema: req.schema, strict: strictable(req.schema) },
        },
      });

      const usage = response.usage;
      const tokensIn = usage?.prompt_tokens ?? 0;
      const tokensOut = usage?.completion_tokens ?? 0;
      const servedBy = response.model ?? req.model;
      const choice = response.choices[0];

      // A refusal is a successful HTTP response carrying a refusal string
      // instead of content — the same shape of event as Anthropic's refusal
      // stop reason, and the same outcome here: narration falls back to the
      // template, the digest still sends.
      if (choice?.message.refusal) {
        return { ok: false, reason: 'refusal', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }
      if (choice?.finish_reason === 'length') {
        return { ok: false, reason: 'max_tokens', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }
      if (choice?.finish_reason === 'content_filter') {
        return { ok: false, reason: 'content_filter', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }

      const text = choice?.message.content ?? '';
      try {
        return { ok: true, json: JSON.parse(text), tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      } catch {
        return { ok: false, reason: 'invalid_json', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }
    } catch (err) {
      const reason = err instanceof OpenAI.APIError ? `api_error_${err.status ?? 'unknown'}` : 'network_or_timeout';
      return { ok: false, reason, tokensIn: 0, tokensOut: 0, model: req.model, provider: PROVIDER };
    }
  }
}

/**
 * Whether a schema can be sent with `strict: true`.
 *
 * Strict mode guarantees the response matches the schema exactly, which is what
 * this seam wants — but OpenAI accepts only a subset of JSON Schema under it,
 * and rejects the whole request otherwise. The schemas in this codebase were
 * written against Anthropic's more permissive structured outputs, so asserting
 * strict unconditionally would turn a schema mismatch into a hard API error
 * rather than a degraded call.
 *
 * So: strict when the schema plainly satisfies the two rules that matter
 * (a closed object whose properties are all required), best-effort otherwise.
 * Best-effort still returns JSON — the downstream validator is what actually
 * enforces shape, and it runs either way.
 */
export function strictable(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  if (schema.additionalProperties !== false) return false;
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return false;
  const required = schema.required;
  if (!Array.isArray(required)) return false;
  const names = Object.keys(properties as Record<string, unknown>);
  return names.length > 0 && names.every((n) => required.includes(n));
}
