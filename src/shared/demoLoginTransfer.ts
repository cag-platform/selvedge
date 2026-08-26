/**
 * The operator demo login deliberately crosses two origins:
 *
 * 1. Selvedge clears any Clerk session already active in this browser.
 * 2. Clerk's Account Portal consumes the one-use sign-in token.
 *
 * Keep both ends fixed. The credential travels in the fragment so it is not
 * sent to Selvedge's server, access logs, or ordinary query analytics.
 */
export const DEMO_WEB_APP_ORIGIN = 'https://tryselvedge.com';
export const DEMO_WEB_TRANSFER_PATH = '/operator/demo-login';
export const DEMO_CLERK_ACCOUNT_PORTAL_HOST = 'accounts.tryselvedge.com';

export function validatedDemoAccountPortalUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== DEMO_CLERK_ACCOUNT_PORTAL_HOST ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    throw new Error(`Demo sign-in must stay on ${DEMO_CLERK_ACCOUNT_PORTAL_HOST}.`);
  }
  return url;
}

export function demoWebTransferUrl(accountPortalUrl: string): string {
  const clerkUrl = validatedDemoAccountPortalUrl(accountPortalUrl);
  const transfer = new URL(DEMO_WEB_TRANSFER_PATH, DEMO_WEB_APP_ORIGIN);
  transfer.hash = encodeURIComponent(clerkUrl.toString());
  return transfer.toString();
}

export function accountPortalUrlFromDemoTransfer(value: string): string {
  const transfer = new URL(value);
  if (
    transfer.origin !== DEMO_WEB_APP_ORIGIN ||
    transfer.pathname !== DEMO_WEB_TRANSFER_PATH ||
    transfer.search !== '' ||
    !transfer.hash
  ) {
    throw new Error('This is not a Selvedge demo-login transfer URL.');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(transfer.hash.slice(1));
  } catch {
    throw new Error('The demo-login credential is not valid percent-encoding.');
  }
  return validatedDemoAccountPortalUrl(decoded).toString();
}
