import type { ContextPack, TopologySource } from '../../shared/types/pack.js';

/**
 * Section ownership, per the Phase 1 brief: connector-driven (machine)
 * writes may only touch topology.sources (additive), baselines, state, and
 * trust. identity, stakes, voice, and capability_gaps change only via
 * user-authenticated endpoints.
 *
 * The brief doesn't say who owns topology.serves/consumes/stack_summary.
 * The schema doc calls all of `topology` "MACHINE-OWNED (human-confirmed
 * once)", but grants the machine side only `sources` explicitly — so these
 * three fields are treated as human-editable here (confirmed during
 * onboarding, alongside capability_gaps), never machine-written. Flagged in
 * the PR description as a brief gap.
 */

export type HumanPatch = {
  identity?: Partial<ContextPack['identity']>;
  stakes?: Partial<ContextPack['stakes']>;
  voice?: Partial<ContextPack['voice']>;
  topology?: Partial<Pick<ContextPack['topology'], 'sources' | 'serves' | 'consumes' | 'stack_summary' | 'capability_gaps'>>;
};

export type MachinePatch = {
  /** New source entries to append. Existing entries are never mutated or removed here. */
  addSources?: TopologySource[];
  baselines?: Partial<NonNullable<ContextPack['baselines']>>;
  state?: Partial<NonNullable<ContextPack['state']>>;
  trust?: Partial<NonNullable<ContextPack['trust']>>;
};

export function applyHumanPatch(pack: ContextPack, patch: HumanPatch): ContextPack {
  return {
    ...pack,
    identity: patch.identity ? { ...pack.identity, ...patch.identity } : pack.identity,
    stakes: patch.stakes ? { ...pack.stakes, ...patch.stakes } : pack.stakes,
    voice: patch.voice ? { ...pack.voice, ...patch.voice } : pack.voice,
    topology: patch.topology ? { ...pack.topology, ...patch.topology } : pack.topology,
  };
}

function sourceKey(s: TopologySource): string {
  return `${s.connector}:${s.resource_id}`;
}

export function applyMachinePatch(pack: ContextPack, patch: MachinePatch): ContextPack {
  let topology = pack.topology;
  if (patch.addSources?.length) {
    const existing = new Set(pack.topology.sources.map(sourceKey));
    const additions = patch.addSources.filter((s) => !existing.has(sourceKey(s)));
    if (additions.length > 0) {
      topology = { ...pack.topology, sources: [...pack.topology.sources, ...additions] };
    }
  }

  return {
    ...pack,
    topology,
    baselines: patch.baselines ? { ...pack.baselines, ...patch.baselines } : pack.baselines,
    state: patch.state ? { ...pack.state, ...patch.state } : pack.state,
    trust: patch.trust ? { ...pack.trust, ...patch.trust } : pack.trust,
  };
}
