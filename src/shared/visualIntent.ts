/** Explicit visual language only; “show me the logs” is not an image request. */
export function wantsVisual(text: string): boolean {
  return /\b(?:create|generate|make|give me|draw|design)\b[\s\S]{0,80}\b(?:visual|image|illustration|mockup|mock-up|concept art|render)\b/i.test(text)
    || /\bmock(?:\s+|-)up\b/i.test(text)
    || /\bvisual(?:s)?\b[\s\S]{0,50}\b(?:interpretation|version|option|direction)s?\b/i.test(text);
}
