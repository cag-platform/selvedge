import { createHmac, timingSafeEqual } from 'node:crypto';

export type RelayAudience = 'connector' | 'viewer';

export type RelayClaims = {
  workspaceId: string;
  orgId: string;
  projectId: string;
  previewId: string;
  port: number;
  audience: RelayAudience;
  expiresAt: number;
};

export class InvalidRelayTokenError extends Error {
  constructor(message = 'invalid preview credential') {
    super(message);
    this.name = 'InvalidRelayTokenError';
  }
}
function encode(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function validClaims(value: unknown): value is RelayClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.workspaceId === 'string' &&
    typeof claims.orgId === 'string' &&
    typeof claims.projectId === 'string' &&
    typeof claims.previewId === 'string' &&
    typeof claims.port === 'number' &&
    Number.isInteger(claims.port) &&
    claims.port > 0 &&
    claims.port <= 65535 &&
    (claims.audience === 'connector' || claims.audience === 'viewer') &&
    typeof claims.expiresAt === 'number'
  );
}

/** Short-lived signed capabilities; no relay credential is stored in plaintext. */
export class PreviewRelayTokens {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('preview relay signing secret must be at least 32 bytes');
  }

  issue(claims: RelayClaims): string {
    const payload = encode(JSON.stringify(claims));
    return `${payload}.${sign(this.secret, payload)}`;
  }

  verify(token: string, audience: RelayAudience, now = Date.now()): RelayClaims {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) throw new InvalidRelayTokenError();
    const expected = sign(this.secret, payload);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new InvalidRelayTokenError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new InvalidRelayTokenError();
    }
    if (!validClaims(parsed) || parsed.audience !== audience || parsed.expiresAt <= now) {
      throw new InvalidRelayTokenError();
    }
    return parsed;
  }
}
