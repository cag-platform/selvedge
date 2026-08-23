/**
 * THE REFUSAL WITH A MOVE IN IT.
 *
 * A builder named inside an idea can't run — there is nowhere to put the code
 * yet — and the server says so with the choices attached rather than as a wall.
 * This reads that refusal, the same way ceiling.ts reads the spend one: a 409
 * body with a shape, turned into something a panel can offer.
 *
 * The message is NOT sent by being told. Whatever was typed stays in the
 * composer, and it is sent again once the conversation has somewhere to build.
 */

export type NeedsProject = {
  /** Which builder was asked for. */
  agent: string;
  /** The projects this conversation could join. */
  projects: Array<{ id: string; name: string }>;
  /**
   * Whether a new project can be started from here at all. False on a
   * deployment with no repo maker — in which case the option is not shown,
   * rather than shown and then refused.
   */
  canCreate: boolean;
};

export function needsProjectOf(body: Record<string, unknown>): NeedsProject | null {
  if (body.code !== 'needs_project') return null;
  const projects = Array.isArray(body.projects)
    ? body.projects.filter(
        (p): p is { id: string; name: string } =>
          Boolean(p) && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' && typeof (p as { name?: unknown }).name === 'string',
      )
    : [];
  return {
    agent: typeof body.agent === 'string' ? body.agent : 'a builder',
    projects,
    canCreate: body.can_create === true,
  };
}

/**
 * The repo a new project would create, shown BEFORE it is created.
 *
 * Minting a repo on somebody's GitHub is irreversible and outward-facing, and
 * arriving at it by naming a builder mid-sentence is exactly how that happens
 * by accident. So the name is derived here, put in front of the person, and
 * only then sent — the same slug the server will make, so what they agreed to
 * is what appears.
 */
export function repoSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
