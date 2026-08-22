import { AGENTS, agentById } from '../../shared/agents.js';

/**
 * WHO IS ANSWERING — a two-or-three character mono mark on a plain field.
 *
 * Agent identity gets its own system because the colour system is spoken for:
 * `--thread` means "this needs you" and nothing else, and a picker full of
 * brand colours would quietly teach people to read colour as vendor rather
 * than as status. So the text carries the identity and the chip is just a
 * container — no logos, no brand colours, ever, including for agents added
 * later (DESIGN-NOTES, the workbench register §6.5).
 */
export function AgentChip({ agent, working = false, title }: { agent: string; working?: boolean; title?: string }) {
  const descriptor = agentById(agent);
  const chip = descriptor?.chip ?? agent.slice(0, 2).toUpperCase();
  return (
    <span
      title={title ?? descriptor?.name ?? agent}
      className="inline-flex items-center gap-1 rounded-inset border border-hairline bg-panel px-1.5 py-0.5 font-mono text-tech leading-none text-ink-dim"
    >
      {chip}
      {/* The working mark: one static dot, no spinner, no pulse. It appears and
          disappears with --settle and does not animate while it is there. */}
      {working && <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-ink-dim" />}
    </span>
  );
}

/**
 * The whole roster. There used to be a filter here, keyed on the thread's kind,
 * and it was the wall: it decided who could answer before anyone knew what the
 * conversation was about. Every agent can join every conversation now, and the
 * picker says what each one does instead of hiding half of them.
 */
export function agentChoices() {
  return [...AGENTS];
}
