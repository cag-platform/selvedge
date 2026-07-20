import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a GitHub webhook delivery's `X-Hub-Signature-256` header against
 * the raw request body. GitHub Apps have one webhook secret shared across
 * every installation. Must run against the exact bytes GitHub sent — the
 * webhook route mounts express.raw() rather than express.json() so this
 * receives an unparsed Buffer.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf-8');
  const actualBuf = Buffer.from(signatureHeader, 'utf-8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
