import { createClerkClient } from '@clerk/express';
import {
  assertDemoLoginConfirmation,
  demoLoginLink,
  demoSignInTokenRequest,
  parseDemoLoginTarget,
  pinnedDemoOrganizationId,
  selectDemoLoginUser,
} from './access.js';
import { DEMO_ACCOUNT_EMAIL } from './config.js';
import { assessDemoOrganization, type DemoOrganizationContext } from './organization.js';

/**
 * Mint a short-lived, single-use login for the isolated marketing account.
 *
 * This is deliberately a terminal-only operator command, not an HTTP route.
 * The credential is printed once and is never written to a file or database by
 * Selvedge. Clerk retains only its own token record until use or expiry.
 */
async function main(): Promise<void> {
  assertDemoLoginConfirmation(process.env.DEMO_LOGIN_CONFIRM);
  const target = parseDemoLoginTarget(process.env.DEMO_LOGIN_TARGET);

  if (!process.stdout.isTTY) {
    throw new Error('Refusing to print a login credential outside an interactive terminal.');
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required to mint a demo login.');

  const clerk = createClerkClient({ secretKey });
  const listed = await clerk.users.getUserList({ emailAddress: [DEMO_ACCOUNT_EMAIL], limit: 2 });
  const user = selectDemoLoginUser(listed.data);

  const memberships = await clerk.users.getOrganizationMembershipList({ userId: user.id, limit: 2 });
  let organizationContext: DemoOrganizationContext = {
    userId: user.id,
    pinnedOrganizationId: pinnedDemoOrganizationId(user),
    userMemberships: memberships,
  };
  if (memberships.totalCount === 1 && memberships.data[0]) {
    const organizationId = memberships.data[0].organization.id;
    const [organization, organizationMemberships, invitations, domains] = await Promise.all([
      clerk.organizations.getOrganization({ organizationId }),
      clerk.organizations.getOrganizationMembershipList({ organizationId, limit: 2 }),
      clerk.organizations.getOrganizationInvitationList({ organizationId, limit: 1 }),
      clerk.organizations.getOrganizationDomainList({ organizationId, limit: 1 }),
    ]);
    organizationContext = {
      ...organizationContext,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdBy: organization.createdBy,
        maxAllowedMemberships: organization.maxAllowedMemberships,
        publicMetadata: organization.publicMetadata as Record<string, unknown> | null,
        privateMetadata: organization.privateMetadata as Record<string, unknown>,
      },
      organizationMemberships,
      invitationCount: invitations.totalCount,
      domainCount: domains.totalCount,
    };
  }
  const organization = assessDemoOrganization(organizationContext);
  if (organization.kind !== 'ready') {
    throw new Error('The demo Clerk organization has not been provisioned and pinned by the demo seeder.');
  }

  const token = await clerk.signInTokens.createSignInToken(demoSignInTokenRequest(user.id));
  const link = demoLoginLink(token, target);

  console.log(`Minted one single-use ${target} demo login. It expires in five minutes.`);
  console.log('Treat this link as a password; do not paste it into chat, tickets, or recordings.');
  if (target === 'web') {
    console.log('Opening it signs out every active Selvedge session in that browser before entering the demo.');
  }
  console.log(`${target === 'web' ? 'Web' : 'iOS'}: ${link}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
