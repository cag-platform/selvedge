import http2 from 'node:http2';
import { createSign } from 'node:crypto';
import { apnsConfig, type ApnsConfig } from './config.js';
import type { PushNotification, PushSendOutcome, PushSender } from './types.js';

/**
 * APNs HTTP/2 sender with token-based (JWT ES256) auth.
 *
 * NOTE: written against Apple's documented APNs provider API but NOT yet run
 * against a live APNs endpoint or a real device — there are no APNs
 * credentials in this environment (see push/config.ts). It is isolated behind
 * the PushSender seam so the rest of the send path is exercised with
 * FakePushSender; this concrete class is the one thing to verify once
 * APNS_* secrets and a test device exist. Same posture as the Clerk key.
 */
export class ApnsPushSender implements PushSender {
  private config: ApnsConfig;
  private cachedToken: { jwt: string; issuedAtMs: number } | null = null;

  constructor(config: ApnsConfig = apnsConfig()) {
    this.config = config;
  }

  /** APNs provider JWTs are valid up to 60 min and should be reused < 60 min. */
  private providerToken(nowMs: number): string {
    if (this.cachedToken && nowMs - this.cachedToken.issuedAtMs < 50 * 60 * 1000) {
      return this.cachedToken.jwt;
    }
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(nowMs / 1000) }));
    const signingInput = `${header}.${claims}`;
    const signer = createSign('SHA256');
    signer.update(signingInput);
    const signature = signer.sign({ key: this.config.authKey, dsaEncoding: 'ieee-p1363' });
    const jwt = `${signingInput}.${base64urlBuffer(signature)}`;
    this.cachedToken = { jwt, issuedAtMs: nowMs };
    return jwt;
  }

  async send(token: string, environment: string, notification: PushNotification): Promise<PushSendOutcome> {
    const host = environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const payload = JSON.stringify({
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: 'default',
        'interruption-level': notification.interruptionLevel ?? 'active',
      },
      ...(notification.data ?? {}),
    });

    return new Promise<PushSendOutcome>((resolve) => {
      const client = http2.connect(`https://${host}`);
      client.on('error', (err) => resolve({ token, ok: false, error: err.message }));

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${this.providerToken(Date.now())}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': notification.interruptionLevel === 'time-sensitive' ? 'alert' : 'alert',
        'content-type': 'application/json',
      });

      let status = 0;
      let responseBody = '';
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        client.close();
        if (status === 200) {
          resolve({ token, ok: true });
          return;
        }
        // 410 = the device token is no longer active; 400 BadDeviceToken too.
        const unregistered = status === 410 || responseBody.includes('BadDeviceToken') || responseBody.includes('Unregistered');
        resolve({ token, ok: false, unregistered, error: `apns ${status}: ${responseBody}` });
      });
      req.on('error', (err) => {
        client.close();
        resolve({ token, ok: false, error: err.message });
      });

      req.setEncoding('utf8');
      req.write(payload);
      req.end();
    });
  }
}

function base64url(input: string): string {
  return base64urlBuffer(Buffer.from(input, 'utf8'));
}

function base64urlBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
