import { randomBytes } from 'node:crypto';
import { createClerkClient, type User } from '@clerk/express';
import { db, sql } from './client.js';
import { assertDemoTenantEmpty, seedDemoWorkspace } from './demoData.js';
import { pinnedDemoOrganizationId, selectDemoLoginUser } from '../demo/access.js';
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_ORGANIZATION_MEMBERSHIP_LIMIT,
  DEMO_ORGANIZATION_NAME,
  DEMO_ORGANIZATION_SLUG,
  DEMO_WORKSPACE,
  demoUserPrivateMetadata,
} from '../demo/config.js';
import {
  assessDemoOrganization,
  assertDemoOrganizationAdoptionConfirmation,
  type DemoOrganizationContext,
} from '../demo/organization.js';

/**
 * Provision and refresh the isolated marketing account.
 *
 * There is intentionally no public route for this and no default confirmation:
 * the command writes real production data and may create a real Clerk login.
 * It only proceeds when the operator names this exact scene.
 */

function generatedPassword(): string {
  // Random rather than a committed shared password. The first-run value is
  // printed once for the owner to put in their password manager.
  return `Nw7!${randomBytes(18).toString('base64url')}`;
}

async function main() {
  if (process.env.DEMO_SEED_CONFIRM !== DEMO_WORKSPACE) {
    throw new Error(`Refusing to seed. Set DEMO_SEED_CONFIRM=${DEMO_WORKSPACE} to name the workspace you intend to replace.`);
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required to provision the demo login.');

  const requestedEmail = process.env.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase();
  if (requestedEmail && requestedEmail !== DEMO_ACCOUNT_EMAIL) {
    throw new Error(`The marketing seed has one fixed login: ${DEMO_ACCOUNT_EMAIL}. DEMO_ACCOUNT_EMAIL cannot override it.`);
  }
  const email = DEMO_ACCOUNT_EMAIL;

  const clerk = createClerkClient({ secretKey });
  const listed = await clerk.users.getUserList({ emailAddress: [email], limit: 2 });
  const exact = listed.data.filter((user) => user.emailAddresses.some((address) => address.emailAddress.toLowerCase() === email));
  if (exact.length > 1) throw new Error(`More than one Clerk user has ${email}; refusing to guess which tenant is safe.`);

  const existingUser = exact[0];
  let user: User;
  let issuedPassword: string | null = null;
  const requestedPassword = process.env.DEMO_ACCOUNT_PASSWORD?.trim();

  if (!existingUser) {
    issuedPassword = requestedPassword || generatedPassword();
    user = await clerk.users.createUser({
      emailAddress: [email],
      password: issuedPassword,
      firstName: 'Avery',
      lastName: 'Northstar',
      privateMetadata: demoUserPrivateMetadata(),
    });
    console.log(`Created isolated Clerk demo user ${user.id}.`);
    // Print the newly issued credential before touching the database. If the
    // database seed fails, the owner can still recover and rotate the account
    // instead of being stranded with an unknown generated password.
    console.log(`Login email: ${email}`);
    console.log(`Login password: ${issuedPassword}`);
    console.log('Save this credential now; workspace seeding follows.');
  } else {
    selectDemoLoginUser([existingUser]);
    user = existingUser;
    if (!requestedPassword) {
      console.log(`Using existing isolated Clerk demo user ${user.id}; password unchanged.`);
    }
  }

  // New Clerk instances require organization membership and can create a first
  // organization on login. Resolve that relationship before writing product
  // data so the browser and database always choose the same tenant.
  const loadOrganizationContext = async (): Promise<DemoOrganizationContext> => {
    const memberships = await clerk.users.getOrganizationMembershipList({ userId: user.id, limit: 2 });
    const context: DemoOrganizationContext = {
      userId: user.id,
      pinnedOrganizationId: pinnedDemoOrganizationId(user),
      userMemberships: memberships,
    };
    if (memberships.totalCount !== 1 || !memberships.data[0]) return context;
    const organizationId = memberships.data[0].organization.id;
    const [organization, organizationMemberships, invitations, domains] = await Promise.all([
      clerk.organizations.getOrganization({ organizationId }),
      clerk.organizations.getOrganizationMembershipList({ organizationId, limit: 2 }),
      clerk.organizations.getOrganizationInvitationList({ organizationId, limit: 1 }),
      clerk.organizations.getOrganizationDomainList({ organizationId, limit: 1 }),
    ]);
    return {
      ...context,
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
  };

  let organizationState = assessDemoOrganization(await loadOrganizationContext());
  if (organizationState.kind === 'provision') {
    const organization = await clerk.organizations.createOrganization({
      name: DEMO_ORGANIZATION_NAME,
      slug: DEMO_ORGANIZATION_SLUG,
      createdBy: user.id,
      maxAllowedMemberships: DEMO_ORGANIZATION_MEMBERSHIP_LIMIT,
    });
    user = await clerk.users.replaceUserMetadata(user.id, {
      privateMetadata: demoUserPrivateMetadata(organization.id),
    });
    console.log(`Created isolated Clerk demo organization ${organization.id}.`);
  } else if (organizationState.kind === 'adoptable') {
    const organizationId = organizationState.organization.id;
    assertDemoOrganizationAdoptionConfirmation(process.env.DEMO_ADOPT_ORG_CONFIRM, organizationId);
    await assertDemoTenantEmpty(db, organizationId);
    // Do not mutate the Clerk organization. The fixed user's private metadata
    // pins its exact id, while createdBy + sole admin + no invites/domains prove
    // the relationship on every seed and login. This works for Clerk's pristine
    // auto-org shape and for the already-applied Northstar profile shape.
    user = await clerk.users.replaceUserMetadata(user.id, {
      privateMetadata: demoUserPrivateMetadata(organizationId),
    });
    console.log(`Adopted isolated Clerk demo organization ${organizationId}.`);
  }

  organizationState = assessDemoOrganization(await loadOrganizationContext());
  if (organizationState.kind !== 'ready') {
    throw new Error('The demo Clerk organization did not reach its fully pinned state; refusing to seed data.');
  }

  const result = await seedDemoWorkspace(db, organizationState.organization.id, new Date(), { boughtByUserId: user.id });
  // Password rotation is last: a wrong organization or unsafe database state
  // must fail without changing the credential or signing out the account an
  // operator may need in order to inspect the problem.
  if (existingUser && requestedPassword) {
    user = await clerk.users.updateUser(user.id, { password: requestedPassword, signOutOfOtherSessions: true });
    issuedPassword = requestedPassword;
    console.log(`Rotated the isolated Clerk demo user's password.`);
  }
  console.log(`Seeded ${result.workspace}: ${result.projects} projects, ${result.threads} conversations, ${result.messages} messages, ${result.openFixes} easy fixes.`);
  console.log(`Login email: ${email}`);
  if (issuedPassword) console.log(`Login password: ${issuedPassword}`);
  else console.log('Login password: unchanged (set DEMO_ACCOUNT_PASSWORD to rotate it).');
  console.log(`Tenant id: ${organizationState.organization.id}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
