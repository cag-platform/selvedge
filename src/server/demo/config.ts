/**
 * Identity of the isolated marketing workspace.
 *
 * Keep these values in one place: both provisioning and operator access must
 * identify the same Clerk user without accepting a caller-supplied target.
 */
export const DEMO_WORKSPACE = 'northstar-studio';
export const DEMO_ACCOUNT_EMAIL = 'demo@tryselvedge.com';
export const DEMO_ORGANIZATION_NAME = 'Northstar Studio';
export const DEMO_ORGANIZATION_SLUG = 'northstar-studio';
export const DEMO_AUTO_ORGANIZATION_NAME = "Avery's Organization";
export const DEMO_AUTO_ORGANIZATION_SLUG = /^avery-s-organization-\d+$/;
export const DEMO_ORGANIZATION_MEMBERSHIP_LIMIT = 1;
export const DEMO_PRIVATE_METADATA = {
  selvedgeDemo: true,
  demoWorkspace: DEMO_WORKSPACE,
} as const;

export function demoUserPrivateMetadata(organizationId?: string) {
  return {
    ...DEMO_PRIVATE_METADATA,
    ...(organizationId ? { demoOrganizationId: organizationId } : {}),
  };
}
