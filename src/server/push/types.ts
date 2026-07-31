/**
 * The narrow push seam — everything above it (the scheduler, the critical-
 * event path) sends through this interface, and only apns.ts touches the
 * network. Mirrors the LlmClient pattern so the whole send path is testable
 * with a fake and no push happens without a configured sender.
 */
export type PushNotification = {
  title: string;
  body: string;
  /** Deep-link payload the native client reads on tap, e.g. { project_id }. */
  data?: Record<string, string>;
  /** APNs interruption-level: critical rows override quiet hours (routing decides). */
  interruptionLevel?: 'active' | 'time-sensitive';
};

export type PushSendOutcome = {
  token: string;
  ok: boolean;
  /** APNs 410 / BadDeviceToken → the token is dead and should be pruned. */
  unregistered?: boolean;
  error?: string;
};

export interface PushSender {
  send(token: string, environment: string, notification: PushNotification): Promise<PushSendOutcome>;
}
