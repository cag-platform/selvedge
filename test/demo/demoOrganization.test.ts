import { describe, expect, it } from 'vitest';
import {
  assessDemoOrganization,
  assertDemoOrganizationAdoptionConfirmation,
  type DemoOrganizationContext,
} from '../../src/server/demo/organization.js';
import {
  DEMO_AUTO_ORGANIZATION_NAME,
  DEMO_ORGANIZATION_MEMBERSHIP_LIMIT,
  DEMO_ORGANIZATION_NAME,
  DEMO_ORGANIZATION_SLUG,
} from '../../src/server/demo/config.js';

const userId = 'user_demo_marketing';
const organizationId = 'org_demo_marketing';

function readyOrganization() {
  return {
    id: organizationId,
    name: DEMO_ORGANIZATION_NAME,
    slug: DEMO_ORGANIZATION_SLUG,
    createdBy: userId,
    maxAllowedMemberships: DEMO_ORGANIZATION_MEMBERSHIP_LIMIT,
    publicMetadata: {},
    privateMetadata: {},
  };
}

function context(overrides: Partial<DemoOrganizationContext> = {}): DemoOrganizationContext {
  return {
    userId,
    pinnedOrganizationId: organizationId,
    userMemberships: {
      totalCount: 1,
      data: [{ role: 'org:admin', organization: { id: organizationId } }],
    },
    organization: readyOrganization(),
    organizationMemberships: {
      totalCount: 1,
      data: [{ role: 'org:admin', publicUserData: { userId } }],
    },
    invitationCount: 0,
    domainCount: 0,
    ...overrides,
  };
}

describe('marketing demo Clerk organization', () => {
  it('provisions only when the unpinned demo user has no memberships', () => {
    expect(assessDemoOrganization(context({
      pinnedOrganizationId: null,
      userMemberships: { totalCount: 0, data: [] },
      organization: undefined,
      organizationMemberships: undefined,
      invitationCount: undefined,
      domainCount: undefined,
    }))).toEqual({ kind: 'provision' });

    expect(() => assessDemoOrganization(context({
      userMemberships: { totalCount: 0, data: [] },
      organization: undefined,
      organizationMemberships: undefined,
      invitationCount: undefined,
      domainCount: undefined,
    }))).toThrow(/pins a Clerk organization/);
  });

  it('recognizes only Clerk’s exact pristine auto-created organization for adoption', () => {
    const pristine = readyOrganization();
    pristine.name = DEMO_AUTO_ORGANIZATION_NAME;
    pristine.slug = 'avery-s-organization-1787685433795921401';
    pristine.maxAllowedMemberships = 5;
    pristine.privateMetadata = {};

    const result = assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: pristine,
    }));
    expect(result).toMatchObject({ kind: 'adoptable', organization: { id: organizationId } });
    expect(() => assertDemoOrganizationAdoptionConfirmation(undefined, organizationId)).toThrow(organizationId);
    expect(() => assertDemoOrganizationAdoptionConfirmation('org_someone_else', organizationId)).toThrow(organizationId);
    expect(() => assertDemoOrganizationAdoptionConfirmation(organizationId, organizationId)).not.toThrow();

    expect(() => assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: { ...pristine, name: 'Real customer' },
    }))).toThrow(/unexpected or modified/);
    expect(() => assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: { ...pristine, privateMetadata: { unrelated: true } },
    }))).toThrow(/unexpected or modified/);
  });

  it('requires the exact private user pin before either accepted organization shape is login-ready', () => {
    expect(assessDemoOrganization(context())).toMatchObject({ kind: 'ready' });
    expect(assessDemoOrganization(context({ pinnedOrganizationId: null }))).toMatchObject({ kind: 'adoptable' });
    expect(() => assessDemoOrganization(context({ pinnedOrganizationId: 'org_other' }))).toThrow(/different Clerk organization/);

    const pristine = {
      ...readyOrganization(),
      name: DEMO_AUTO_ORGANIZATION_NAME,
      slug: 'avery-s-organization-1787685433795921401',
      maxAllowedMemberships: 5,
    };
    expect(assessDemoOrganization(context({ organization: pristine }))).toMatchObject({ kind: 'ready' });
  });

  it('accepts the exact applied Northstar profile without mutating Clerk organization metadata', () => {
    const halfAdopted = readyOrganization();
    expect(assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: halfAdopted,
    }))).toMatchObject({ kind: 'adoptable', organization: { id: organizationId } });

    expect(() => assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: { ...halfAdopted, slug: 'northstar-studio-copy' },
    }))).toThrow(/unexpected or modified/);
    expect(() => assessDemoOrganization(context({
      pinnedOrganizationId: null,
      organization: { ...halfAdopted, privateMetadata: { unrelated: true } },
    }))).toThrow(/unexpected or modified/);
    expect(assessDemoOrganization(context({ organization: halfAdopted }))).toMatchObject({ kind: 'ready' });
  });

  it('keeps the pinned demo ready after its sole admin renames the auto-created profile', () => {
    const renamed = {
      ...readyOrganization(),
      slug: 'avery-s-organization-1787685433795921401',
      maxAllowedMemberships: 5,
    };
    expect(assessDemoOrganization(context({ organization: renamed }))).toMatchObject({ kind: 'ready' });
    expect(() => assessDemoOrganization(context({
      organization: { ...renamed, name: 'Another workspace' },
    }))).toThrow(/unexpected or modified/);
  });

  it('fails closed on additional memberships, members, invitations, or a non-admin owner', () => {
    expect(() => assessDemoOrganization(context({
      userMemberships: {
        totalCount: 2,
        data: [
          { role: 'org:admin', organization: { id: organizationId } },
          { role: 'org:admin', organization: { id: 'org_other' } },
        ],
      },
    }))).toThrow(/exactly one Clerk organization/);

    expect(() => assessDemoOrganization(context({
      organizationMemberships: {
        totalCount: 2,
        data: [
          { role: 'org:admin', publicUserData: { userId } },
          { role: 'org:member', publicUserData: { userId: 'user_other' } },
        ],
      },
    }))).toThrow(/exactly one member/);
    expect(() => assessDemoOrganization(context({ invitationCount: 1 }))).toThrow(/must not have invitations/);
    expect(() => assessDemoOrganization(context({ domainCount: 1 }))).toThrow(/must not have verified domains/);
    expect(() => assessDemoOrganization(context({
      userMemberships: { totalCount: 1, data: [{ role: 'org:member', organization: { id: organizationId } }] },
    }))).toThrow(/must be the admin/);
  });

  it('rejects an organization created by a different user or carrying any organization marker', () => {
    expect(() => assessDemoOrganization(context({
      organization: { ...readyOrganization(), createdBy: 'user_other' },
    }))).toThrow(/not created by/);
    expect(() => assessDemoOrganization(context({
      organization: {
        ...readyOrganization(),
        privateMetadata: { selvedgeDemo: true, demoUserId: 'user_other' },
      },
    }))).toThrow(/unexpected or modified/);
  });
});
