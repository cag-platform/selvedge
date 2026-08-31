import { afterEach, describe, expect, it } from 'vitest';
import { engineEnv } from '../../src/server/build/engineConfig.js';

const original = {
  provider: process.env.WORKSPACE_PROVIDER,
  openai: process.env.OPENAI_API_KEY,
  workspace: process.env.BL_WORKSPACE,
  blaxel: process.env.BL_API_KEY,
  relaySecret: process.env.PREVIEW_RELAY_SIGNING_SECRET,
  relayOrigin: process.env.PREVIEW_RELAY_PUBLIC_ORIGIN,
};

afterEach(() => {
  const restore = (name: string, value: string | undefined) => value === undefined ? delete process.env[name] : void (process.env[name] = value);
  restore('WORKSPACE_PROVIDER', original.provider);
  restore('OPENAI_API_KEY', original.openai);
  restore('BL_WORKSPACE', original.workspace);
  restore('BL_API_KEY', original.blaxel);
  restore('PREVIEW_RELAY_SIGNING_SECRET', original.relaySecret);
  restore('PREVIEW_RELAY_PUBLIC_ORIGIN', original.relayOrigin);
});

describe('workspace provider configuration', () => {
  it('enables the Blaxel pilot without requiring an OpenAI infrastructure key', () => {
    process.env.WORKSPACE_PROVIDER = 'blaxel';
    delete process.env.OPENAI_API_KEY;
    process.env.BL_WORKSPACE = 'selvedge';
    process.env.BL_API_KEY = 'bl_test';
    process.env.PREVIEW_RELAY_SIGNING_SECRET = 'relay-secret';
    process.env.PREVIEW_RELAY_PUBLIC_ORIGIN = 'https://tryselvedge.com';
    expect(engineEnv()).toEqual({ workspaceRuntime: true });
  });

  it('refuses an unknown or incomplete provider configuration', () => {
    process.env.PREVIEW_RELAY_SIGNING_SECRET = 'relay-secret';
    process.env.PREVIEW_RELAY_PUBLIC_ORIGIN = 'https://tryselvedge.com';
    process.env.WORKSPACE_PROVIDER = 'unknown';
    expect(engineEnv()).toBeNull();
    process.env.WORKSPACE_PROVIDER = 'blaxel';
    delete process.env.BL_API_KEY;
    expect(engineEnv()).toBeNull();
  });
});
