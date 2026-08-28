import { describe, expect, it } from 'vitest';
import { PreviewRelayBroker, PreviewRelayUnavailableError } from '../../src/server/workspace/relay/broker.js';

describe('PreviewRelayBroker', () => {
  it('multiplexes a browser request over the outbound workspace connection', async () => {
    const sent: string[] = [];
    const broker = new PreviewRelayBroker(1000);
    broker.attach('preview_1', { send: (message) => sent.push(message), close: () => {} });

    const pending = broker.forward('preview_1', {
      method: 'GET', path: '/', headers: { accept: 'text/html' }, bodyBase64: null,
    });
    const request = JSON.parse(sent[0]!);
    broker.receive('preview_1', JSON.stringify({
      type: 'response', id: request.id, status: 200,
      headers: { 'content-type': 'text/html' }, bodyBase64: Buffer.from('hello').toString('base64'),
    }));

    await expect(pending).resolves.toMatchObject({ status: 200, bodyBase64: Buffer.from('hello').toString('base64') });
  });

  it('fails outstanding requests when the workspace disconnects', async () => {
    const broker = new PreviewRelayBroker(1000);
    const detach = broker.attach('preview_1', { send: () => {}, close: () => {} });
    const pending = broker.forward('preview_1', { method: 'GET', path: '/', headers: {}, bodyBase64: null });
    detach();
    await expect(pending).rejects.toBeInstanceOf(PreviewRelayUnavailableError);
  });
});
