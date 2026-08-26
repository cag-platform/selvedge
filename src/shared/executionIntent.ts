export type ExecutionMode = 'plan' | 'build';

/** Capability follows the verb, not the agent's identity. Explicit mode wins. */
export function executionModeFor(text: string, explicit?: unknown): ExecutionMode {
  if (explicit === 'plan' || explicit === 'build') return explicit;
  const normalized = text.toLowerCase();
  if (/\b(implement|build it|code it|fix|edit|change the code|add the|remove the|ship)\b/.test(normalized)) return 'build';
  if (/\b(plan|inspect|look at|review|analy[sz]e|walk me through|rundown|assess|investigate)\b/.test(normalized)) return 'plan';
  return 'build';
}
