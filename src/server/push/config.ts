/**
 * Push is disabled entirely (no-op) unless APNs credentials are configured —
 * the same posture as the LLM voice (llm/config.ts). These are deploy-time
 * secrets; the app boots and runs without them, it just doesn't send.
 */
export function pushEnabled(): boolean {
  return Boolean(
    process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_BUNDLE_ID && process.env.APNS_AUTH_KEY,
  );
}

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** The .p8 auth-key contents (PEM). */
  authKey: string;
  /** Sandbox by default in non-production; overridable per device row. */
  defaultHost: 'api.push.apple.com' | 'api.sandbox.push.apple.com';
};

export function apnsConfig(): ApnsConfig {
  return {
    keyId: process.env.APNS_KEY_ID!,
    teamId: process.env.APNS_TEAM_ID!,
    bundleId: process.env.APNS_BUNDLE_ID!,
    authKey: process.env.APNS_AUTH_KEY!,
    defaultHost: process.env.NODE_ENV === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
  };
}
