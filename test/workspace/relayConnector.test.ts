import type { IncomingMessage } from 'node:http';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { previewConnectorSource } from '../../src/server/workspace/relay/connector.js';
import { PreviewRelayBroker } from '../../src/server/workspace/relay/broker.js';
import { PreviewRelaySessions } from '../../src/server/workspace/relay/session.js';
import { connectorCredential, createPreviewRelayWeb } from '../../src/server/workspace/relay/web.js';

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
    expect(source).toContain("authorization: 'Bearer ' + config.token");
    expect(source).toContain("method: 'POST'");
    expect(source).toContain("/^https:\\/\\//");
    expect(source).not.toContain('console.log');
    expect(source).not.toContain("addEventListener('error', () => socket.close())");
    expect(source).not.toContain('new WebSocket');
  });

  it('carries a browser request and workspace response over authenticated HTTPS polling', async () => {
    const sessions = new PreviewRelaySessions('this-test-secret-is-long-enough-for-hmac', 'https://preview.test');
    const broker = new PreviewRelayBroker(1_000);
    const web = createPreviewRelayWeb(sessions, broker);
    const app = express().use(web.router);
    const session = sessions.create({ workspaceId: 'ws_1', orgId: 'org_1', projectId: 'loom', port: 3000, ttlMinutes: 5 });
    const auth = `Bearer ${session.connectorToken}`;

    const poll = request(app).get(`/workspace-relay/poll/${session.id}`).set('Authorization', auth).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const forwarded = broker.forward(session.id, { method: 'GET', path: '/', headers: {}, bodyBase64: null });
    const envelope = await poll;
    const relayed = JSON.parse(envelope.body.message);
    expect(relayed).toMatchObject({ type: 'request', method: 'GET', path: '/' });

    await request(app)
      .post(`/workspace-relay/poll/${session.id}`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send({ type: 'response', id: relayed.id, status: 200, headers: { 'content-type': 'text/plain' }, bodyBase64: 'b2s=' })
      .expect(202);
    await expect(forwarded).resolves.toMatchObject({ status: 200, bodyBase64: 'b2s=' });
  });
});
