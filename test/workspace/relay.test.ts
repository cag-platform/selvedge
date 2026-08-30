import { describe, expect, it } from 'vitest';
import { safeRelayHeaders } from '../../src/server/workspace/relay/protocol.js';
import { PreviewRelaySessions } from '../../src/server/workspace/relay/session.js';
import { InvalidRelayTokenError } from '../../src/server/workspace/relay/tokens.js';

const SECRET = 'this-is-a-test-secret-that-is-long-enough-for-hmac';

describe('Preview Relay capabilities', () => {
  it('gives the workspace and viewer different, expiring capabilities', () => {
    const relay = new PreviewRelaySessions(SECRET, 'https://preview.selvedge.test', () => 1_000);
    const session = relay.create({ workspaceId: 'ws_1', orgId: 'org_1', projectId: 'loom', port: 3000, ttlMinutes: 10 });

    expect(session.connectorToken).not.toBe(session.viewerToken);
    expect(relay.verifyConnector(session.connectorToken)).toMatchObject({
      workspaceId: 'ws_1', orgId: 'org_1', projectId: 'loom', port: 3000, audience: 'connector',
    });
    expect(relay.verifyViewer(session.viewerToken).audience).toBe('viewer');
    expect(() => relay.verifyViewer(session.connectorToken)).toThrow(InvalidRelayTokenError);
    expect(session.previewUrl).toContain('/workspace-preview/');
    expect(session.pollUrl).toContain('/workspace-relay/poll/');
  });

  it('rejects tampering and expiry', () => {
    let now = 1_000;
    const relay = new PreviewRelaySessions(SECRET, 'https://preview.selvedge.test', () => now);
    const session = relay.create({ workspaceId: 'ws_1', orgId: 'org_1', projectId: 'loom', port: 3000, ttlMinutes: 1 });
    expect(() => relay.verifyConnector(`${session.connectorToken}x`)).toThrow(InvalidRelayTokenError);
    now += 60_001;
    expect(() => relay.verifyConnector(session.connectorToken)).toThrow(InvalidRelayTokenError);
  });

  it('never forwards browser auth, cookies, upgrades or set-cookie into customer code', () => {
    expect(safeRelayHeaders({
      authorization: 'Bearer owner-session',
      cookie: 'session=secret',
      connection: 'upgrade',
      upgrade: 'websocket',
      'set-cookie': 'customer=secret',
      accept: 'text/html',
      'x-request-id': ['one', 'two'],
    })).toEqual({ accept: 'text/html', 'x-request-id': 'one, two' });
  });
});
