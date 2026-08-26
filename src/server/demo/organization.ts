import {
  DEMO_AUTO_ORGANIZATION_NAME,
  DEMO_AUTO_ORGANIZATION_SLUG,
  DEMO_ORGANIZATION_MEMBERSHIP_LIMIT,
  DEMO_ORGANIZATION_NAME,
  DEMO_ORGANIZATION_SLUG,
} from './config.js';

type Page<T> = { data: readonly T[]; totalCount: number };

export type DemoOrganization = {
  id: string;
  name: string;
  slug: string;
  createdBy?: string;
  maxAllowedMemberships: number;
  publicMetadata: Record<string, unknown> | null;
  privateMetadata: Record<string, unknown>;
};

export type DemoUserOrganizationMembership = {
  role: string;
  organization: { id: string };
};

export type DemoOrganizationMembership = {
  role: string;
  publicUserData?: { userId: string } | null;
};

export type DemoOrganizationAssessment =
  | { kind: 'provision' }
  | { kind: 'adoptable'; organization: DemoOrganization }
  | { kind: 'ready'; organization: DemoOrganization };

export type DemoOrganizationContext = {
  userId: string;
  pinnedOrganizationId: string | null;
  userMemberships: Page<DemoUserOrganizationMembership>;
  organization?: DemoOrganization;
  organizationMemberships?: Page<DemoOrganizationMembership>;
  invitationCount?: number;
  domainCount?: number;
};

function exactRecord(actual: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  if (!actual) return Object.keys(expected).length === 0;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) =>
    actualKeys[index] === key && actual[key] === expected[key]);
}

function organizationRelationship(context: DemoOrganizationContext): DemoOrganization {
  const membership = context.userMemberships.data[0];
  const organization = context.organization;
  if (!membership || !organization || membership.organization.id !== organization.id) {
    throw new Error('The demo user membership does not resolve to one exact Clerk organization.');
  }
  if (membership.role !== 'org:admin') {
    throw new Error('The demo user must be the admin of its Clerk organization.');
  }
  if (organization.createdBy !== context.userId) {
    throw new Error('The demo Clerk organization was not created by the fixed demo user.');
  }

  const members = context.organizationMemberships;
  if (!members || members.totalCount !== 1 || members.data.length !== 1) {
    throw new Error('The demo Clerk organization must have exactly one member.');
  }
  const onlyMember = members.data[0];
  if (onlyMember?.publicUserData?.userId !== context.userId || onlyMember.role !== 'org:admin') {
    throw new Error('The demo Clerk organization must contain only the fixed demo user as admin.');
  }
  if (context.invitationCount !== 0) {
    throw new Error('The demo Clerk organization must not have invitations.');
  }
  if (context.domainCount !== 0) {
    throw new Error('The demo Clerk organization must not have verified domains.');
  }
  return organization;
}

/**
 * Prove which Clerk organization owns the marketing scene before either the
 * seeder or login tool touches it. The unmarked branch is intentionally narrow:
 * it recognizes only Clerk's pristine, automatically-created organization for
 * Avery. Once adopted, the exact organization id is pinned in the fixed demo
 * user's private metadata. Organization profile/metadata updates are not part
 * of the trust boundary: createdBy plus sole-admin membership prove the other
 * side without requiring a Clerk permission this operator key does not have.
 */
export function assessDemoOrganization(context: DemoOrganizationContext): DemoOrganizationAssessment {
  const memberships = context.userMemberships;
  if (memberships.totalCount === 0 && memberships.data.length === 0) {
    if (context.pinnedOrganizationId) {
      throw new Error('The demo user pins a Clerk organization but has no organization membership.');
    }
    return { kind: 'provision' };
  }
  if (memberships.totalCount !== 1 || memberships.data.length !== 1) {
    throw new Error('The demo user must belong to exactly one Clerk organization.');
  }

  const organization = organizationRelationship(context);
  const publicMetadataIsEmpty = exactRecord(organization.publicMetadata, {});
  const privateMetadataIsEmpty = exactRecord(organization.privateMetadata, {});
  const organizationHasFinalShape =
    organization.name === DEMO_ORGANIZATION_NAME &&
    organization.slug === DEMO_ORGANIZATION_SLUG &&
    organization.maxAllowedMemberships === DEMO_ORGANIZATION_MEMBERSHIP_LIMIT &&
    publicMetadataIsEmpty &&
    privateMetadataIsEmpty;
  const organizationHasPristineAutoShape =
    organization.name === DEMO_AUTO_ORGANIZATION_NAME &&
    DEMO_AUTO_ORGANIZATION_SLUG.test(organization.slug) &&
    organization.maxAllowedMemberships === 5 &&
    publicMetadataIsEmpty &&
    privateMetadataIsEmpty;
  // The sole admin can rename the organization through Clerk's member-facing
  // profile UI even when this instance's Backend API cannot patch it. That UI
  // deliberately leaves Clerk's generated slug and membership limit alone.
  const organizationHasRenamedAutoShape =
    organization.name === DEMO_ORGANIZATION_NAME &&
    DEMO_AUTO_ORGANIZATION_SLUG.test(organization.slug) &&
    organization.maxAllowedMemberships === 5 &&
    publicMetadataIsEmpty &&
    privateMetadataIsEmpty;

  if (!organizationHasFinalShape && !organizationHasPristineAutoShape && !organizationHasRenamedAutoShape) {
    throw new Error('The demo user belongs to an unexpected or modified Clerk organization.');
  }
  if (context.pinnedOrganizationId === null) return { kind: 'adoptable', organization };
  if (context.pinnedOrganizationId !== organization.id) {
    throw new Error('The demo user is pinned to a different Clerk organization.');
  }
  return { kind: 'ready', organization };
}

export function assertDemoOrganizationAdoptionConfirmation(value: string | undefined, organizationId: string): void {
  if (value !== organizationId) {
    throw new Error(
      `Refusing to adopt the unmarked demo organization. Set DEMO_ADOPT_ORG_CONFIRM=${organizationId} to name the exact Clerk organization.`,
    );
  }
}
