import { describe, expect, it } from 'vitest';
import { isExpiredWorkspaceError } from '../../src/server/build/sandbox.js';
import { OpenAiWorkspaceApiError } from '../../src/server/workspace/openai/client.js';

describe('expired workspace recovery', () => {
  it('recognizes both a missing container and OpenAI\'s explicit expiration response', () => {
    expect(isExpiredWorkspaceError(new OpenAiWorkspaceApiError(404, null, 'not found'))).toBe(true);
    expect(isExpiredWorkspaceError(new OpenAiWorkspaceApiError(400, 'container_expired', 'Container has expired.'))).toBe(true);
  });

  it('does not turn unrelated provider failures into destructive workspace replacement', () => {
    expect(isExpiredWorkspaceError(new OpenAiWorkspaceApiError(400, 'invalid_request', 'Bad network policy'))).toBe(false);
    expect(isExpiredWorkspaceError(new OpenAiWorkspaceApiError(429, 'rate_limit', 'Try later'))).toBe(false);
    expect(isExpiredWorkspaceError(new Error('Container has expired.'))).toBe(false);
  });
});
