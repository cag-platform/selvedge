import type { LlmClient, LlmRequest, LlmResult } from './types.js';

/**
 * Deterministic in-process client for tests and for the eval harness's
 * hermetic mode (no ANTHROPIC_API_KEY). Responds from a queue or a
 * request->response function; records every request it saw.
 */
export class FakeLlmClient implements LlmClient {
  requests: LlmRequest[] = [];
  private responder: (req: LlmRequest) => LlmResult;

  constructor(responder?: (req: LlmRequest) => LlmResult) {
    this.responder =
      responder ??
      ((req) => ({
        ok: true,
        json: {},
        tokensIn: Math.ceil((req.system.length + req.userContent.length) / 4),
        tokensOut: 50,
        model: req.model,
      }));
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    return this.responder(req);
  }
}

/** A client that always fails — outage simulation (acceptance gate 6). */
export class DownLlmClient implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResult> {
    return { ok: false, reason: 'network_or_timeout', tokensIn: 0, tokensOut: 0, model: req.model };
  }
}
