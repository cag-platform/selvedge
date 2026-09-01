import type { AgentId } from '../../shared/agents.js';

export type AutoRouteCandidate = {
  id: AgentId;
  changes_files: boolean;
  available: boolean;
};

export type AutoRouteDecision = {
  agent: AgentId;
  capability: 'talk' | 'build';
  reason: string;
  used_preference: boolean;
  avoided_recent_failure: boolean;
};

/**
 * Auto is deliberately conservative. A question about code is still a
 * conversation; only an explicit request to change or run the project earns a
 * sandbox. This prevents "what is wrong here?" from silently becoming a
 * mutating turn.
 */
export function autoCapability(text: string, hasProject: boolean, hasAttachments = false): 'talk' | 'build' {
  if (!hasProject) return 'talk';
  if (hasAttachments) return 'build';
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const asksOnly = /^(?:how|why|what|when|where|which|explain|review|inspect|analy[sz]e|compare|tell me)\b/.test(normalized);
  const explicitBuild = /\b(?:build|implement|execute|proceed|fix|edit|code|create|add|remove|change|update|install|refactor|migrate|start|run)\b/.test(normalized);
  return explicitBuild && !asksOnly ? 'build' : 'talk';
}

/**
 * Pick only from agents proven available by the roster. Familiar tools win;
 * then the current capable worker; then the registry's stable neutral order.
 * A recent failed build is avoided when another eligible worker exists.
 */
export function chooseAutoAgent(input: {
  text: string;
  hasProject: boolean;
  hasAttachments?: boolean;
  current: AgentId;
  preferred: readonly AgentId[];
  candidates: readonly AutoRouteCandidate[];
  recentlyFailed?: ReadonlySet<AgentId>;
}): AutoRouteDecision | null {
  const capability = autoCapability(input.text, input.hasProject, input.hasAttachments);
  const wantsFiles = capability === 'build';
  const eligible = input.candidates.filter((candidate) => candidate.available && candidate.changes_files === wantsFiles);
  if (!eligible.length) return null;

  const failed = input.recentlyFailed ?? new Set<AgentId>();
  const healthy = eligible.filter((candidate) => !failed.has(candidate.id));
  const pool = healthy.length ? healthy : eligible;
  const preferred = input.preferred.map((id) => pool.find((candidate) => candidate.id === id)).find(Boolean);
  const current = pool.find((candidate) => candidate.id === input.current);
  const selected = preferred ?? current ?? pool[0]!;
  const usedPreference = Boolean(preferred);
  const avoidedFailure = healthy.length > 0 && eligible.some((candidate) => failed.has(candidate.id));
  const reason = usedPreference
    ? `${selected.id} is one of your preferred ${capability === 'build' ? 'coding' : 'chat'} agents and is available.`
    : current
      ? `${selected.id} is already carrying this conversation and fits this ${capability === 'build' ? 'code change' : 'question'}.`
      : `${selected.id} is an available ${capability === 'build' ? 'coding' : 'chat'} agent for this turn.`;

  return {
    agent: selected.id,
    capability,
    reason: avoidedFailure ? `${reason} A recently failed alternative was skipped.` : reason,
    used_preference: usedPreference,
    avoided_recent_failure: avoidedFailure,
  };
}
