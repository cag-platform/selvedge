export type ExecutionMode = 'plan' | 'build';

/**
 * High-confidence owner language that means "cross the repository boundary".
 * Questions and explicit negations stay conversational; ambiguous uses of
 * "publish" without a concrete object do not become a deployment decision.
 */
export function isShipRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\b(?:do not|don't|dont|not yet|without)\s+(?:commit|push|ship|publish|deploy)\b/.test(normalized)) return false;
  if (/^(?:how|why|what|when|where)\b/.test(normalized)) return false;
  return /\b(?:commit\s+(?:it|this|these|the changes)?\s*(?:and|&)\s*push|push\s+(?:it|this|these|the\s+changes|changes|to\s+(?:main|github))|ship\s+(?:it|this|these|the\s+changes|changes)|(?:publish|deploy)\s+(?:it|this|these|the\s+(?:changes|latest\s+version)|changes|the\s+app))\b/.test(normalized);
}

/** Capability follows the verb, not the agent's identity. Explicit mode wins. */
export function executionModeFor(text: string, explicit?: unknown): ExecutionMode {
  if (explicit === 'plan' || explicit === 'build') return explicit;
  const normalized = text.toLowerCase();
  if (/\b(implement|build it|code it|fix|edit|change the code|add the|remove the)\b/.test(normalized)) return 'build';
  if (/\b(plan|inspect|look at|review|analy[sz]e|walk me through|rundown|assess|investigate)\b/.test(normalized)) return 'plan';
  return 'build';
}
