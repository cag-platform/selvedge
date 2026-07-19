import type { LlmClient, LlmRequest, LlmResult } from '../src/server/llm/types.js';

/**
 * Hermetic-mode stand-in for the composer model (no ANTHROPIC_API_KEY).
 * Deterministically composes a well-formed brief from the composer input —
 * fragments verbatim (so verdict phrases survive), closed threads first,
 * standing and quiet lines appended. This exercises the full Stage 1->2
 * pipeline, the validator, and every gated code check; with a real key the
 * same fixtures exercise the real prompts instead.
 *
 * A `breakVerdicts` mock exists to prove the harness fails on a seeded
 * regression (acceptance gate 1).
 */
export class MockComposerClient implements LlmClient {
  constructor(private options: { breakVerdicts?: boolean; padWords?: number } = {}) {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    const schema = req.schema as { properties?: Record<string, unknown> };
    const isComposeCall = Boolean(schema.properties && 'brief' in schema.properties);
    if (!isComposeCall) {
      // Fragment-shaped request (only reached in real-key Stage 1 runs).
      return {
        ok: true,
        json: { fragment: 'Mock fragment — users are fine.', verdict: 'users_fine', technical_line: 'mock', confidence: 'high' },
        tokensIn: 100,
        tokensOut: 30,
        model: req.model,
      };
    }

    const input = JSON.parse(req.userContent.split('\n\nYour previous composition failed validation:')[0]!) as {
      fragments: Array<{ project: string; kind: string; fragment: string }>;
      closed_threads: string[];
      standing: string[];
      quiet: string;
    };

    const paragraphs: string[] = [];
    const attention = input.fragments.filter((f) => f.kind === 'attention');
    const moved = input.fragments.filter((f) => f.kind === 'moved');

    paragraphs.push(
      attention.length === 0 ? 'A calm morning across the board.' : `${attention.length} thing${attention.length === 1 ? '' : 's'} worth a look this morning.`,
    );
    paragraphs.push(...input.closed_threads);
    paragraphs.push(...attention.map((f) => (this.options.breakVerdicts ? `${f.project}: something happened overnight.` : f.fragment)));
    paragraphs.push(...moved.map((f) => f.fragment));
    paragraphs.push(...input.standing);
    if (input.quiet) paragraphs.push(input.quiet);
    if (this.options.padWords) paragraphs.push('word '.repeat(this.options.padWords).trim());

    return {
      ok: true,
      json: { brief: paragraphs.filter(Boolean).join('\n\n') },
      tokensIn: Math.ceil(req.userContent.length / 4),
      tokensOut: 200,
      model: req.model,
    };
  }
}
