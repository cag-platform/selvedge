import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { previewConnectorSource } from '../../src/server/workspace/relay/connector.js';
import { connectorCredential } from '../../src/server/workspace/relay/web.js';

describe('Preview Relay workspace connector', () => {
  it('accepts a short-lived connector capability via WebSocket subprotocol', () => {
    const req = { headers: { 'sec-websocket-protocol': 'selvedge-preview, signed.capability' } } as IncomingMessage;
    expect(connectorCredential(req)).toBe('signed.capability');
  });

  it('prefers Authorization for non-browser WebSocket clients', () => {
    const req = { headers: {
      authorization: 'Bearer header-capability',
      'sec-websocket-protocol': 'selvedge-preview, protocol-capability',
    } } as IncomingMessage;
    expect(connectorCredential(req)).toBe('header-capability');
  });

  it('ships a credential-safe, loopback-only connector', () => {
    const source = previewConnectorSource();
    expect(source).toContain('unlinkSync(configPath)');
    expect(source).toContain("target.hostname !== '127.0.0.1'");
    expect(source).toContain("['selvedge-preview', config.token]");
    expect(source).not.toContain('console.log');
  });
});
