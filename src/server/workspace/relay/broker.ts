import { randomUUID } from 'node:crypto';
import type { RelayRequest, RelayResponse, WorkspaceToRelayMessage } from './protocol.js';

export interface RelayTransport {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}
type Pending = {
  resolve: (response: RelayResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Connection = {
  transport: RelayTransport;
  pending: Map<string, Pending>;
};

export class PreviewRelayUnavailableError extends Error {}
export class PreviewRelayTimeoutError extends Error {}

/**
 * Multiplexes browser HTTP requests over one outbound workspace connection.
 * The registry is intentionally in-process for the first slice; before running
 * multiple Selvedge replicas it must be backed by sticky routing or a shared
 * relay service. The API makes that replacement local to this module.
 */
export class PreviewRelayBroker {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly timeoutMs = 30_000) {}

  attach(previewId: string, transport: RelayTransport): () => void {
    const prior = this.connections.get(previewId);
    if (prior) {
      this.failConnection(prior, new PreviewRelayUnavailableError('preview connector was replaced'));
      prior.transport.close(4001, 'replaced');
    }
    const connection: Connection = { transport, pending: new Map() };
    this.connections.set(previewId, connection);
    return () => {
      if (this.connections.get(previewId) !== connection) return;
      this.connections.delete(previewId);
      this.failConnection(connection, new PreviewRelayUnavailableError('preview connector disconnected'));
    };
  }

  receive(previewId: string, raw: string): void {
    const connection = this.connections.get(previewId);
    if (!connection) return;
    let message: WorkspaceToRelayMessage;
    try {
      message = JSON.parse(raw) as WorkspaceToRelayMessage;
    } catch {
      connection.transport.close(4002, 'invalid message');
      return;
    }
    if (message.type !== 'response') return;
    const pending = connection.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    connection.pending.delete(message.id);
    pending.resolve(message);
  }

  forward(previewId: string, request: Omit<RelayRequest, 'type' | 'id'>): Promise<RelayResponse> {
    const connection = this.connections.get(previewId);
    if (!connection) return Promise.reject(new PreviewRelayUnavailableError('preview is not connected'));
    const id = randomUUID();
    const message: RelayRequest = { type: 'request', id, ...request };
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new PreviewRelayTimeoutError('preview request timed out'));
      }, this.timeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      try {
        connection.transport.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  connected(previewId: string): boolean {
    return this.connections.has(previewId);
  }

  private failConnection(connection: Connection, error: Error): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  }
}
