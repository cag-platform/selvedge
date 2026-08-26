import { describe, expect, it } from 'vitest';
import {
  DEMO_LOGIN_TTL_SECONDS,
  assertDemoLoginConfirmation,
  demoLoginLink,
  demoSignInTokenRequest,
  parseDemoLoginTarget,
  pinnedDemoOrganizationId,
  selectDemoLoginUser,
  type DemoLoginUser,
} from '../../src/server/demo/access.js';
import { DEMO_ACCOUNT_EMAIL, DEMO_WORKSPACE } from '../../src/server/demo/config.js';
import {
  accountPortalUrlFromDemoTransfer,
  DEMO_WEB_TRANSFER_PATH,
} from '../../src/shared/demoLoginTransfer.js';

function demoUser(overrides: Partial<DemoLoginUser> = {}): DemoLoginUser {
  return {
    id: 'user_demo_marketing',
    banned: false,
    locked: false,
    passwordEnabled: true,
    primaryEmailAddressId: 'idn_demo',
    privateMetadata: { selvedgeDemo: true, demoWorkspace: DEMO_WORKSPACE },
    emailAddresses: [
      {
        id: 'idn_demo',
        emailAddress: DEMO_ACCOUNT_EMAIL,
        verification: { status: 'verified' },
      },
    ],
    ...overrides,
  };
}

describe('operator demo access', () => {
  it('requires the exact workspace confirmation', () => {
    expect(() => assertDemoLoginConfirmation(undefined)).toThrow(/Refusing to mint/);
    expect(() => assertDemoLoginConfirmation('northstar')).toThrow(/Refusing to mint/);
    expect(() => assertDemoLoginConfirmation(DEMO_WORKSPACE)).not.toThrow();
  });

  it('requires one exact capture target before minting', () => {
    expect(() => parseDemoLoginTarget(undefined)).toThrow(/exactly web or ios/);
    expect(() => parseDemoLoginTarget('mobile')).toThrow(/exactly web or ios/);
    expect(parseDemoLoginTarget('web')).toBe('web');
    expect(parseDemoLoginTarget('ios')).toBe('ios');
  });

  it('accepts only the isolated, verified Clerk identity', () => {
    expect(selectDemoLoginUser([demoUser()]).id).toBe('user_demo_marketing');
    expect(() => selectDemoLoginUser([])).toThrow(/No Clerk user/);
    expect(() => selectDemoLoginUser([demoUser(), demoUser({ id: 'user_duplicate' })])).toThrow(/More than one/);
    expect(() =>
      selectDemoLoginUser([
        demoUser({ privateMetadata: { selvedgeDemo: true, demoWorkspace: 'somewhere-else' } }),
      ]),
    ).toThrow(/not marked/);
    expect(() =>
      selectDemoLoginUser([
        demoUser({
          privateMetadata: { selvedgeDemo: true, demoWorkspace: DEMO_WORKSPACE, unrelated: true },
        }),
      ]),
    ).toThrow(/not marked/);
    expect(() => selectDemoLoginUser([demoUser({ locked: true })])).toThrow(/banned or locked/);
    expect(() => selectDemoLoginUser([demoUser({ passwordEnabled: false })])).toThrow(/password identity/);
  });

  it('accepts only one well-formed reciprocal organization pin', () => {
    const pinned = demoUser({
      privateMetadata: {
        selvedgeDemo: true,
        demoWorkspace: DEMO_WORKSPACE,
        demoOrganizationId: 'org_demo_marketing',
      },
    });
    expect(pinnedDemoOrganizationId(selectDemoLoginUser([pinned]))).toBe('org_demo_marketing');
    expect(pinnedDemoOrganizationId(selectDemoLoginUser([demoUser()]))).toBeNull();
    expect(() => selectDemoLoginUser([demoUser({
      privateMetadata: {
        selvedgeDemo: true,
        demoWorkspace: DEMO_WORKSPACE,
        demoOrganizationId: 'user_not_an_org',
      },
    })])).toThrow(/not marked/);
  });

  it('requires one verified primary demo email', () => {
    expect(() =>
      selectDemoLoginUser([
        demoUser({
          emailAddresses: [
            { id: 'idn_demo', emailAddress: DEMO_ACCOUNT_EMAIL, verification: { status: 'unverified' } },
          ],
        }),
      ]),
    ).toThrow(/one verified primary email/);

    expect(() =>
      selectDemoLoginUser([
        demoUser({
          emailAddresses: [
            { id: 'idn_demo', emailAddress: DEMO_ACCOUNT_EMAIL, verification: { status: 'verified' } },
            { id: 'idn_other', emailAddress: 'other@example.com', verification: { status: 'verified' } },
          ],
        }),
      ]),
    ).toThrow(/one verified primary email/);
  });

  it('always requests a five-minute Clerk token', () => {
    expect(DEMO_LOGIN_TTL_SECONDS).toBe(300);
    expect(demoSignInTokenRequest('user_demo_marketing')).toEqual({
      userId: 'user_demo_marketing',
      expiresInSeconds: 300,
    });
  });

  it('returns only the selected web or encoded iOS representation', () => {
    const token = {
      id: 'sit_demo',
      token: 'ticket with /?&%# reserved',
      url: 'https://accounts.tryselvedge.com/sign-in?__clerk_ticket=sit_demo',
    };

    const web = demoLoginLink(token, 'web');
    expect(web).toBe(
      'https://tryselvedge.com/operator/demo-login#https%3A%2F%2Faccounts.tryselvedge.com%2Fsign-in%3F__clerk_ticket%3Dsit_demo',
    );
    expect(accountPortalUrlFromDemoTransfer(web)).toBe(token.url);
    expect(new URL(web).pathname).toBe(DEMO_WEB_TRANSFER_PATH);
    const ios = demoLoginLink(token, 'ios');
    expect(ios).toBe('selvedge://auth-ticket#ticket%20with%20%2F%3F%26%25%23%20reserved');
    expect(decodeURIComponent(ios.split('#')[1]!)).toBe('ticket with /?&%# reserved');
    expect(() =>
      demoLoginLink(
        { id: 'sit_bad', token: 'ticket', url: 'https://accounts.tryselvedge.com.evil.example/sign-in' },
        'web',
      ),
    ).toThrow(/must stay on accounts\.tryselvedge\.com/);
    expect(() =>
      demoLoginLink(
        { id: 'sit_bad', token: 'ticket', url: 'http://accounts.tryselvedge.com/sign-in' },
        'ios',
      ),
    ).toThrow(/must stay on accounts\.tryselvedge\.com/);
  });

  it('rejects open redirects in either layer of the web handoff', () => {
    const disguisedAccountPortal = encodeURIComponent(
      'https://accounts.tryselvedge.com.evil.example/sign-in?__clerk_ticket=sit_demo',
    );
    expect(() =>
      accountPortalUrlFromDemoTransfer(
        `https://tryselvedge.com/operator/demo-login#${disguisedAccountPortal}`,
      ),
    ).toThrow(/must stay on accounts\.tryselvedge\.com/);

    const validAccountPortal = encodeURIComponent(
      'https://accounts.tryselvedge.com/sign-in?__clerk_ticket=sit_demo',
    );
    expect(() =>
      accountPortalUrlFromDemoTransfer(
        `https://evil.example/operator/demo-login#${validAccountPortal}`,
      ),
    ).toThrow(/not a Selvedge demo-login transfer URL/);

    expect(() =>
      accountPortalUrlFromDemoTransfer(
        `https://tryselvedge.com/operator/demo-login?next=https://evil.example#${validAccountPortal}`,
      ),
    ).toThrow(/not a Selvedge demo-login transfer URL/);
  });
});
