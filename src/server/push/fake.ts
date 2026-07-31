import type { PushNotification, PushSendOutcome, PushSender } from './types.js';

/** Deterministic in-process sender for tests. Records everything it "sent";
 * treats any token passed to the constructor as unregistered (410). */
export class FakePushSender implements PushSender {
  sent: Array<{ token: string; environment: string; notification: PushNotification }> = [];
  private unregistered: Set<string>;

  constructor(unregisteredTokens: string[] = []) {
    this.unregistered = new Set(unregisteredTokens);
  }

  async send(token: string, environment: string, notification: PushNotification): Promise<PushSendOutcome> {
    this.sent.push({ token, environment, notification });
    if (this.unregistered.has(token)) return { token, ok: false, unregistered: true };
    return { token, ok: true };
  }
}
