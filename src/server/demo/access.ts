import type { User } from '@clerk/express';
import { demoWebTransferUrl, validatedDemoAccountPortalUrl } from '../../shared/demoLoginTransfer.js';
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_PRIVATE_METADATA,
  DEMO_WORKSPACE,
} from './config.js';

/** Clerk sign-in tokens are single-use. Keep the credential useful only long
 * enough to move it from this terminal into the browser or simulator. */
export const DEMO_LOGIN_TTL_SECONDS = 5 * 60;

type DemoEmailAddress = Pick<User['emailAddresses'][number], 'id' | 'emailAddress'> & {
  verification: { status: string } | null;
};

export type DemoLoginUser = Pick<
  User,
  'id' | 'banned' | 'locked' | 'passwordEnabled' | 'primaryEmailAddressId' | 'privateMetadata'
> & {
  emailAddresses: DemoEmailAddress[];
};

export type DemoSignInToken = {
  id: string;
  token: string;
  url: string;
};

export type DemoLoginTarget = 'web' | 'ios';

export function assertDemoLoginConfirmation(value: string | undefined): void {
  if (value !== DEMO_WORKSPACE) {
    throw new Error(
      `Refusing to mint a demo login. Set DEMO_LOGIN_CONFIRM=${DEMO_WORKSPACE} to name the exact workspace.`,
    );
  }
}

export function parseDemoLoginTarget(value: string | undefined): DemoLoginTarget {
  if (value !== 'web' && value !== 'ios') {
    throw new Error('Refusing to mint a demo login. Set DEMO_LOGIN_TARGET to exactly web or ios.');
  }
  return value;
}

/**
 * Select the one exact Clerk identity this operator tool is allowed to access.
 * The Backend API search is not treated as an authorization check: every
 * identifying property is checked again before a credential can be minted.
 */
export function selectDemoLoginUser(users: readonly DemoLoginUser[]): DemoLoginUser {
  const exact = users.filter((user) =>
    user.emailAddresses.some((address) => address.emailAddress.toLowerCase() === DEMO_ACCOUNT_EMAIL),
  );

  if (exact.length === 0) {
    throw new Error(`No Clerk user has the exact demo email ${DEMO_ACCOUNT_EMAIL}.`);
  }
  if (exact.length > 1) {
    throw new Error(`More than one Clerk user has ${DEMO_ACCOUNT_EMAIL}; refusing to choose a target.`);
  }

  const user = exact[0];
  if (!user) {
    // Kept explicit for TypeScript's noUncheckedIndexedAccess; the length guard
    // above is the user-facing branch.
    throw new Error(`No Clerk user has the exact demo email ${DEMO_ACCOUNT_EMAIL}.`);
  }
  const primary = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId);
  if (
    user.emailAddresses.length !== 1 ||
    primary?.emailAddress.toLowerCase() !== DEMO_ACCOUNT_EMAIL ||
    primary.verification?.status !== 'verified'
  ) {
    throw new Error(`The demo user must have one verified primary email, exactly ${DEMO_ACCOUNT_EMAIL}.`);
  }

  const metadata = user.privateMetadata as Record<string, unknown>;
  const metadataKeys = Object.keys(metadata).sort();
  const pinnedOrganizationId = metadata.demoOrganizationId;
  const expectedMetadataKeys = pinnedOrganizationId === undefined
    ? ['demoWorkspace', 'selvedgeDemo']
    : ['demoOrganizationId', 'demoWorkspace', 'selvedgeDemo'];
  if (
    metadataKeys.length !== expectedMetadataKeys.length ||
    metadataKeys.some((key, index) => key !== expectedMetadataKeys[index]) ||
    metadata.selvedgeDemo !== DEMO_PRIVATE_METADATA.selvedgeDemo ||
    metadata.demoWorkspace !== DEMO_PRIVATE_METADATA.demoWorkspace ||
    (pinnedOrganizationId !== undefined &&
      (typeof pinnedOrganizationId !== 'string' || !pinnedOrganizationId.startsWith('org_')))
  ) {
    throw new Error(`The ${DEMO_ACCOUNT_EMAIL} user is not marked as the ${DEMO_WORKSPACE} demo.`);
  }
  if (user.banned || user.locked) {
    throw new Error('The demo user is banned or locked; refusing to mint a credential for it.');
  }
  if (!user.passwordEnabled) {
    throw new Error('The demo user no longer has its expected password identity; refusing to mint a credential.');
  }

  return user;
}

export function pinnedDemoOrganizationId(user: DemoLoginUser): string | null {
  const value = (user.privateMetadata as Record<string, unknown>).demoOrganizationId;
  return typeof value === 'string' ? value : null;
}

export function demoSignInTokenRequest(userId: string): { userId: string; expiresInSeconds: number } {
  return { userId, expiresInSeconds: DEMO_LOGIN_TTL_SECONDS };
}

export function demoLoginLink(token: DemoSignInToken, target: DemoLoginTarget): string {
  const accountPortalUrl = validatedDemoAccountPortalUrl(token.url);

  // The native parser intentionally accepts only a fragment so the credential
  // is less likely to enter ordinary query logging or analytics.
  const ios = `selvedge://auth-ticket#${encodeURIComponent(token.token)}`;
  return target === 'web' ? demoWebTransferUrl(accountPortalUrl.toString()) : ios;
}
