import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResult } from './types.js';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages.js';

const TIMEOUT_MS = 60_000;
/** Stamped on every result so spend attributes to a provider, not just a model id. */
const PROVIDER = 'anthropic';

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

  /**
   * `baseURL` points this client at an Anthropic-COMPATIBLE endpoint (Z.ai's
   * and Kimi's coding-plan APIs speak this protocol). Only the fuel verifier
   * uses it — chat and grading always run against Anthropic itself.
   */
  constructor(apiKey?: string, opts: { baseURL?: string } = {}) {
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      timeout: TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async probeModel(model: string): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.client.models.retrieve(model);
      return { available: true };
    } catch (error) {
      if (error instanceof Anthropic.APIError) return { available: false, reason: `api_error_${error.status ?? 'unknown'}` };
      return { available: false, reason: 'network_or_timeout' };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      const useFallbacks = req.model === 'claude-fable-5';
      const content: MessageCreateParamsNonStreaming['messages'][number]['content'] = [
        { type: 'text', text: req.userContent },
        ...(req.attachments ?? []).map((attachment) => {
          if (attachment.kind === 'image') {
            return { type: 'image' as const, source: { type: 'base64' as const, media_type: attachment.mime, data: attachment.dataBase64 } };
          }
          if (attachment.mime === 'application/pdf') {
            return { type: 'document' as const, title: attachment.name, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: attachment.dataBase64 } };
          }
          return { type: 'document' as const, title: attachment.name, source: { type: 'text' as const, media_type: 'text/plain' as const, data: Buffer.from(attachment.dataBase64, 'base64').toString('utf8') } };
        }),
      ];
      const input = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        output_config: { format: { type: 'json_schema' as const, schema: req.schema } },
        messages: [{ role: 'user' as const, content }],
      };
      const response = req.onTextDelta && !useFallbacks
        ? await (async () => {
            const stream = this.client.messages.stream(input);
            stream.on('text', (text) => req.onTextDelta?.(text));
            return stream.finalMessage();
          })()
        : useFallbacks
        ? await this.client.beta.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            betas: ['server-side-fallback-2026-06-01'],
            fallbacks: [{ model: 'claude-opus-4-8' }],
            system: req.system,
            output_config: { format: { type: 'json_schema', schema: req.schema } },
            messages: [{ role: 'user', content }],
          })
        : await this.client.messages.create(input);

      const tokensIn = response.usage.input_tokens;
      const tokensOut = response.usage.output_tokens;
      const servedBy = response.model ?? req.model;

      if (response.stop_reason === 'refusal') {
        return { ok: false, reason: 'refusal', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }
      if (response.stop_reason === 'max_tokens') {
        return { ok: false, reason: 'max_tokens', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }

      const blocks = response.content as readonly { type: string; text?: string }[];
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');

      try {
        return { ok: true, json: JSON.parse(text), tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      } catch {
        return { ok: false, reason: 'invalid_json', tokensIn, tokensOut, model: servedBy, provider: PROVIDER };
      }
    } catch (err) {
      const reason =
        err instanceof Anthropic.APIError ? `api_error_${err.status ?? 'unknown'}` : 'network_or_timeout';
      return { ok: false, reason, tokensIn: 0, tokensOut: 0, model: req.model, provider: PROVIDER };
    }
  }
}
