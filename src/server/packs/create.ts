import type { Db } from '../db/client.js';
import { createPack, getPack } from './store.js';
import { PackValidationError } from './validate.js';
import { scaffoldPack, slugifyProjectId } from './scaffold.js';
import { canCreateProject } from '../billing/entitlements.js';
import { GithubError } from '../connectors/github/newRepo.js';
import type { ContextPack, StakesTier } from '../../shared/types/pack.js';
import type { Allowance } from '../billing/entitlements.js';

/**
 * MAKING A PROJECT — the one copy of it.
 *
 * There are two doors now: the New Project form, and naming a builder inside
 * an idea chat ("start a new one"). The second arrived long after the first,
 * and the ordering here is load-bearing enough that two copies of it would be
 * a real bug rather than an untidiness:
 *
 *   1. THE PLAN GATE FIRES BEFORE ANYTHING IS MADE, and specifically before a
 *      repo is minted. A limit that bites after a side effect leaves somebody
 *      with a repo they don't get to use and no project attached to it.
 *   2. THE REPO IS CREATED BEFORE THE PACK. A GitHub failure then leaves
 *      nothing half-made; a pack failure after leaves a repo and no project,
 *      which is visible, harmless, and fixed by making the project again.
 *
 * A second door that got that order wrong would be discovered by a customer.
 */

export type NewProject = {
  name: string;
  /** An existing repo, or null to make one. */
  repo: string | null;
  tier: StakesTier;
  touchesMoney?: boolean;
  downtimeTranslation?: string;
};

export type CreateDeps = {
  /** Make a fresh private repo. Absent when the deployment has no GITHUB_TOKEN. */
  createRepo?: (name: string, description: string) => Promise<{ fullName: string }>;
};

export type CreateResult =
  | { ok: true; pack: ContextPack }
  /** A plan limit — carries the shape the 402 refusal is built from. */
  | { ok: false; kind: 'limit'; allowance: Allowance }
  | { ok: false; kind: 'invalid' | 'exists' | 'no_repo_maker' | 'github' | 'validation'; status: number; error: string; details?: unknown };

export async function createProject(db: Db, orgId: string, input: NewProject, deps: CreateDeps = {}): Promise<CreateResult> {
  const name = input.name.trim();
  const projectId = slugifyProjectId(name);
  if (!projectId) return { ok: false, kind: 'invalid', status: 400, error: 'name must contain at least one letter or number' };
  if (await getPack(db, orgId, projectId)) {
    return { ok: false, kind: 'exists', status: 409, error: `a project with id "${projectId}" already exists` };
  }

  // (1) Before anything is made.
  const room = await canCreateProject(db, orgId);
  if (!room.allowed) return { ok: false, kind: 'limit', allowance: room };

  // (2) The repo, then the pack.
  let repo: string;
  if (input.repo === null) {
    if (!deps.createRepo) {
      return {
        ok: false,
        kind: 'no_repo_maker',
        status: 503,
        error: 'Creating repos needs the build engine’s GITHUB_TOKEN — set it, or pick an existing repo.',
      };
    }
    try {
      repo = (await deps.createRepo(projectId, `${name} — created by Selvedge`)).fullName;
    } catch (err: unknown) {
      if (err instanceof GithubError) {
        return {
          ok: false,
          kind: 'github',
          status: err.alreadyExists ? 409 : 502,
          error: `GitHub did not create the repo: ${err.message}. Nothing was created.`,
        };
      }
      throw err;
    }
  } else {
    repo = input.repo.trim();
  }

  const pack = scaffoldPack({
    name,
    repo,
    tier: input.tier,
    touches_money: input.touchesMoney,
    downtime_translation: input.downtimeTranslation?.trim() || undefined,
  });
  try {
    await createPack(db, orgId, pack);
  } catch (err: unknown) {
    if (err instanceof PackValidationError) {
      return { ok: false, kind: 'validation', status: 422, error: err.message, details: err.errors };
    }
    throw err;
  }
  return { ok: true, pack };
}
