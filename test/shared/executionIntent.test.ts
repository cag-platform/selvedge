import { describe, expect, it } from 'vitest';
import { executionModeFor, isShipRequest } from '../../src/shared/executionIntent.js';

describe('execution intent', () => {
  it('routes inspection and planning read-only while preserving explicit implementation', () => {
    expect(executionModeFor('Look at the code and plan the migration. Walk me through it.')).toBe('plan');
    expect(executionModeFor('Implement the migration now.')).toBe('build');
    expect(executionModeFor('Execute that plan now in the isolated workspace.')).toBe('build');
    expect(executionModeFor('Resolve the blocker, install dependencies, and start the preview.')).toBe('build');
    expect(executionModeFor('Continue this migration automatically. Inspect the plan, prepare the isolated copy, and run independent browser verification.')).toBe('build');
    expect(executionModeFor('Plan it', 'build')).toBe('build');
  });
});

describe('shipping intent', () => {
  it.each(['push this to main', 'commit and push', 'ship it', 'can you deploy the app?', 'publish the latest version'])(
    'intercepts %s before a builder can act', (text) => expect(isShipRequest(text)).toBe(true),
  );
  it.each(["don't push yet", 'how do I push this?', 'fix this before we push', 'publish a blog post', 'review the deployment plan'])(
    'does not turn %s into owner approval', (text) => expect(isShipRequest(text)).toBe(false),
  );
});
