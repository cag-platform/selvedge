import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResult } from './types.js';

const TIMEOUT_MS = 60_000;

/**
 * The one file that touches the network. Timeout + one retry (SDK-level,
 * per the brief); structured outputs via output_config.format so responses
 * are schema-conformant JSON, not free text. No sampling params and no
 * thinking config — the 5-family models reject temperature/top_p, and
 * thinking defaults (adaptive on Sonnet 5, always-on for Fable 5) are what
 * we want anyway.
 *
 * Fable 5 specifics handled here: a refusal is a successful HTTP response
 * with stop_reason "refusal" — that's a failed call for our purposes
 * (narration falls back to template; the digest must always send), and the
 * server-side fallback parameter is enabled by default so a policy decline
 * on the compose call retries on Opus in the same round trip.
 */
export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      timeout: TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      const useFallbacks = req.model === 'claude-fable-5';
      const response = useFallbacks
        ? await this.client.beta.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            betas: ['server-side-fallback-2026-06-01'],
            fallbacks: [{ model: 'claude-opus-4-8' }],
            system: req.system,
            output_config: { format: { type: 'json_schema', schema: req.schema } },
            messages: [{ role: 'user', content: req.userContent }],
          })
        : await this.client.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            output_config: { format: { type: 'json_schema', schema: req.schema } },
            messages: [{ role: 'user', content: req.userContent }],
          });

      const tokensIn = response.usage.input_tokens;
      const tokensOut = response.usage.output_tokens;
      const servedBy = response.model ?? req.model;

      if (response.stop_reason === 'refusal') {
        return { ok: false, reason: 'refusal', tokensIn, tokensOut, model: servedBy };
      }
      if (response.stop_reason === 'max_tokens') {
        return { ok: false, reason: 'max_tokens', tokensIn, tokensOut, model: servedBy };
      }

      const text = response.content
        .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
        .map((b) => b.text)
        .join('');

      try {
        return { ok: true, json: JSON.parse(text), tokensIn, tokensOut, model: servedBy };
      } catch {
        return { ok: false, reason: 'invalid_json', tokensIn, tokensOut, model: servedBy };
      }
    } catch (err) {
      const reason =
        err instanceof Anthropic.APIError ? `api_error_${err.status ?? 'unknown'}` : 'network_or_timeout';
      return { ok: false, reason, tokensIn: 0, tokensOut: 0, model: req.model };
    }
  }
}
