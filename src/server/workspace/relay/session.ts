import { randomBytes } from 'node:crypto';
import { PreviewRelayTokens, type RelayClaims } from './tokens.js';

export type PreviewRelaySession = {
  id: string;
  workspaceId: string;
  orgId: string;
  projectId: string;
  port: number;
  expiresAt: Date;
  connectorToken: string;
  viewerToken: string;
  connectorUrl: string;
  previewUrl: string;
};

export type CreatePreviewRelaySession = {
  workspaceId: string;
  orgId: string;
  projectId: string;
  port: number;
  ttlMinutes: number;
};

/**
 * Issues the two capabilities that meet at Selvedge:
 *   connector — the workspace may open one outbound tunnel for its local port
 *   viewer    — the browser may view that preview, but cannot become a connector
 */
export class PreviewRelaySessions {
  private readonly tokens: PreviewRelayTokens;

  constructor(
    secret: string,
    private readonly publicOrigin: string,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = new PreviewRelayTokens(secret);
  }

  get origin(): string {
    return this.publicOrigin.replace(/\/$/, '');
  }

  create(input: CreatePreviewRelaySession): PreviewRelaySession {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('preview port is invalid');
    if (!Number.isFinite(input.ttlMinutes) || input.ttlMinutes <= 0 || input.ttlMinutes > 24 * 60) {
      throw new Error('preview TTL is invalid');
    }
    const id = `preview_${randomBytes(16).toString('hex')}`;
    const expiresAtMs = this.now() + input.ttlMinutes * 60_000;
    const base: Omit<RelayClaims, 'audience'> = {
      workspaceId: input.workspaceId,
      orgId: input.orgId,
      projectId: input.projectId,
      previewId: id,
      port: input.port,
      expiresAt: expiresAtMs,
    };
    const connectorToken = this.tokens.issue({ ...base, audience: 'connector' });
    const viewerToken = this.tokens.issue({ ...base, audience: 'viewer' });
    const origin = this.origin;
    return {
      id,
      workspaceId: input.workspaceId,
      orgId: input.orgId,
      projectId: input.projectId,
      port: input.port,
      expiresAt: new Date(expiresAtMs),
      connectorToken,
      viewerToken,
      connectorUrl: `${origin}/workspace-relay/connect/${encodeURIComponent(id)}`,
      previewUrl: `${origin}/workspace-preview/${encodeURIComponent(id)}/?preview_token=${encodeURIComponent(viewerToken)}`,
    };
  }

  verifyConnector(token: string): RelayClaims {
    return this.tokens.verify(token, 'connector', this.now());
  }

  verifyViewer(token: string): RelayClaims {
    return this.tokens.verify(token, 'viewer', this.now());
  }
}
