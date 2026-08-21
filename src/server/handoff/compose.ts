import { agentById, type AgentId } from '../../shared/agents.js';
import { collapseRepeatedLines } from '../../shared/repeats.js';
import { estimateTokens } from '../../shared/tokens.js';
import type { ThreadKind } from '../../shared/types/thread.js';
import type { ContextPack } from '../../shared/types/pack.js';

/**
 * THE HANDOFF — what one agent needs to know to pick up another's work without
 * the owner explaining anything twice.
 *
 * This is the seam the whole Inbox turns on. Switching builders mid-thread is
 * only worth doing if the second agent starts where the first one stopped;
 * otherwise it's a fresh chat wearing the thread's clothes, and the owner pays
 * for the re-explaining in both money and patience.
 *
 * PURE. No database, no network, no model call. It takes the pack, the thread,
 * and who is taking over, and returns text. That means it is exhaustively
 * testable, costs nothing to compose, and — the load-bearing part — cannot
 * invent: every sentence it produces is assembled from something it was handed.
 *
 * It reuses the digest composer's machinery, in the sense that matters: the same
 * deterministic skeleton (select -> collapse repeats -> sections -> render),
 * with code deciding what is included and prose being only a rendering of that
 * decision. `collapseRepeatedLines` is literally the digest's rule, extracted so
 * the two can't drift.
 *
 * WHAT IT DELIBERATELY LEAVES OUT:
 *  - The standing agent rules (who the owner is, no terminal, never hand over a
 *    command checklist). Those already ride on every turn through
 *    --append-system-prompt, and a payload that repeated them would spend the
 *    owner's tokens saying what the system prompt already says.
 *  - The code. The repository is in the sandbox and is the truth; a handoff that
 *    quoted diffs would be enormous and out of date on arrival.
 *  - Anything not in the record. If the thread doesn't say it, the payload
 *    doesn't either — a confident summary of work nobody did is the same
 *    unforgivable output as a false all-clear, one layer down.
 *
 * THE SIZE TARGET, stated honestly: under 10% of the full transcript's tokens
 * for a thread with real history — from roughly twenty rounds of work on, which
 * is where switching agents mid-task actually happens and where pasting the
 * transcript actually hurts. The mechanism is an absolute cap
 * (MAX_PAYLOAD_TOKENS), so the ratio only improves as a thread grows: a
 * year-long thread hands over for the same price as a week-old one.
 *
 * On a SHORT thread the payload can be larger than the transcript it replaces,
 * because the project context is a fixed cost and a four-message conversation
 * has almost nothing to compress. That is the right trade and not a defect —
 * what the new agent needs to know about a live shop that takes money doesn't
 * get cheaper just because this particular thread is young — but it is said
 * plainly here rather than hidden behind an average.
 *
 * The returned counts are both measured with the same estimator, so the caller
 * can tell the owner the real size of what it sent rather than guessing.
 */

export type HandoffRole = 'owner' | 'agent' | 'activity';

export type HandoffMessage = {
  role: HandoffRole;
  content: string;
};

export type HandoffRun = {
  kind: 'turn' | 'plan' | 'ship' | 'undo';
  status: string;
  costCents?: number | null;
  commitSha?: string | null;
  changedPaths?: string[] | null;
};

export type HandoffThread = {
  id: string;
  title: string;
  kind: ThreadKind;
  /** Who has been doing the work up to now. */
  agent: AgentId;
  messages: HandoffMessage[];
  runs?: HandoffRun[];
  /** Does the sandbox hold changes nobody has shipped? */
  stagedChangesReady?: boolean;
};

export type HandoffSections = {
  project: string[];
  story: string[];
  standing: string[];
  /** The owner's most recent ask, verbatim — the instruction the new agent acts on. */
  ask: string | null;
  /** How many older conversation lines were dropped to fit the budget. Said out loud, never silently. */
  omitted: number;
};

export type HandoffPayload = {
  thread_id: string;
  from_agent: AgentId;
  to_agent: AgentId;
  /** What the new agent is started with. */
  text: string;
  sections: HandoffSections;
  /** Estimated size of the payload, and of the transcript it stands in for (same estimator, so the ratio means something). */
  estimated_tokens: number;
  transcript_tokens: number;
};

/** Bounds. Every one of them exists so a long thread produces a payload, not a paste. */
const MAX_PAYLOAD_TOKENS = 1200;
const MAX_CONVERSATION_LINES = 8;
const MAX_OWNER_CHARS = 400;
const MAX_REPLY_CHARS = 180;
const MAX_ASK_CHARS = 2000;
const MAX_WORK_LINES = 8;
const MAX_FILES_NAMED = 8;
const MAX_FLAKY = 3;
const MAX_GAPS = 2;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const one = squash(text);
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence, which is where an agent's reply says what it did. */
function firstSentence(text: string, max: number): string {
  const one = squash(text);
  const stop = one.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? one.slice(0, stop + 1) : one;
  return clip(sentence, max);
}

function agentName(id: AgentId): string {
  return agentById(id)?.name ?? id;
}

/** What this project IS — the part a fresh agent has no way to work out from the code alone. */
export function projectLines(pack: ContextPack | null): string[] {
  if (!pack) {
    return ["I don't have a context pack for this project, so what follows is only what the conversation itself says."];
  }
  const lines: string[] = [];
  lines.push(`${pack.identity.name} — ${clip(pack.identity.owner_description, 300)}`);
  if (pack.identity.audience) lines.push(`Who it serves: ${clip(pack.identity.audience, 160)}`);

  const stakes: string[] = [];
  if (pack.stakes.tier === 'live_critical' || pack.stakes.tier === 'live_small') {
    stakes.push('This is live software with real users');
  } else if (pack.stakes.tier === 'personal') {
    stakes.push('A personal project, no outside users');
  } else {
    stakes.push('A sandbox — nothing depends on it yet');
  }
  if (pack.stakes.touches_money) stakes.push('it handles money');
  lines.push(`${stakes.join(', ')}.`);
  if (pack.stakes.downtime_translation) lines.push(`If it breaks: ${clip(pack.stakes.downtime_translation, 200)}`);

  if (pack.topology.stack_summary) lines.push(`Built with: ${clip(pack.topology.stack_summary, 200)}`);
  const live = pack.identity.links?.live_url;
  if (live) lines.push(`Live at ${live}`);

  const flaky = (pack.baselines?.known_flaky ?? []).filter((f) => !f.graduated).slice(0, MAX_FLAKY);
  for (const f of flaky) {
    lines.push(`Known to be flaky, don't chase it: ${clip(f.note ?? f.pattern, 160)}`);
  }
  for (const gap of (pack.topology.capability_gaps ?? []).slice(0, MAX_GAPS)) {
    lines.push(`Not wired up yet: ${clip(gap.summary, 160)}`);
  }
  return lines;
}

/**
 * The story so far, most recent last: what was asked, what was answered, what
 * was actually touched. Activity lines are collapsed the way the brief collapses
 * a day's repeats, because a thread says "Editing checkout.ts" eleven times.
 */
export function storyLines(thread: HandoffThread): { conversation: string[]; work: string[] } {
  const from = agentName(thread.agent);
  const conversation: string[] = [];
  const activity: string[] = [];

  for (const message of thread.messages) {
    if (message.role === 'owner') {
      conversation.push(`The owner asked: "${clip(message.content, MAX_OWNER_CHARS)}"`);
    } else if (message.role === 'agent') {
      const said = firstSentence(message.content, MAX_REPLY_CHARS);
      if (said) conversation.push(`${from}: ${said}`);
    } else {
      for (const line of message.content.split('\n')) {
        const cleaned = squash(line);
        if (cleaned) activity.push(cleaned);
      }
    }
  }

  const runs = thread.runs ?? [];
  const files = [...new Set(runs.flatMap((r) => r.changedPaths ?? []))];
  const ships = runs.filter((r) => r.kind === 'ship' && r.commitSha);
  const undos = runs.filter((r) => r.kind === 'undo');
  const spentCents = runs.reduce((sum, r) => sum + (r.costCents ?? 0), 0);

  const work: string[] = [];
  if (files.length) {
    const named = files.slice(0, MAX_FILES_NAMED).join(', ');
    work.push(files.length > MAX_FILES_NAMED ? `Files changed so far: ${named}, and ${files.length - MAX_FILES_NAMED} more.` : `Files changed so far: ${named}.`);
  }
  for (const ship of ships.slice(-3)) {
    work.push(`Shipped ${ship.commitSha!.slice(0, 7)}.`);
  }
  if (undos.length) work.push(`A ship was undone here ${undos.length === 1 ? 'once' : `${undos.length} times`}.`);
  // The collapsed tool activity: the distinct things this thread has actually
  // been doing, in the order they first appeared, each carrying how often it
  // happened. Ordered after the outcomes because the outcomes are what matter —
  // the steps are context for them.
  work.push(...collapseRepeatedLines(activity).slice(0, MAX_WORK_LINES));
  if (spentCents > 0) work.push(`This thread has cost about $${(spentCents / 100).toFixed(2)} so far.`);

  return { conversation, work };
}

/** Where the work actually stands right now — the part a new agent must not guess at. */
export function standingLines(thread: HandoffThread): string[] {
  const lines: string[] = [];
  const runs = thread.runs ?? [];
  const last = runs.at(-1);

  if (thread.kind === 'workshop') {
    lines.push(
      thread.stagedChangesReady
        ? 'There are changes in the sandbox that have NOT been shipped yet. Continue from them; do not start over.'
        : 'Nothing is waiting to ship — the sandbox matches what was last committed.',
    );
  }
  if (last && last.status === 'failed') {
    lines.push('The last turn failed partway, so some of that work may be half-done. Check before you repeat it.');
  }
  return lines;
}

function renderPayload(thread: HandoffThread, sections: HandoffSections): string {
  const from = agentName(thread.agent);
  const blocks: string[] = [
    `You are picking up work already in progress, from ${from}, inside Selvedge. The owner has explained all of this once already — do not make them do it again. What follows is the record, not a guess; where it is silent, say so rather than assuming.`,
    ['THE PROJECT', ...sections.project.map((l) => `- ${l}`)].join('\n'),
  ];

  const story = ['WHAT HAS HAPPENED IN THIS THREAD ("' + clip(thread.title, 80) + '")'];
  if (sections.omitted > 0) {
    story.push(`- (${sections.omitted} earlier ${sections.omitted === 1 ? 'line' : 'lines'} of this conversation left out to keep this short)`);
  }
  story.push(...sections.story.map((l) => `- ${l}`));
  blocks.push(story.join('\n'));

  if (sections.standing.length) {
    blocks.push(['WHERE THINGS STAND', ...sections.standing.map((l) => `- ${l}`)].join('\n'));
  }

  blocks.push(
    sections.ask
      ? ['WHAT YOU ARE BEING ASKED TO DO NOW', sections.ask].join('\n')
      : ['WHAT YOU ARE BEING ASKED TO DO NOW', 'Nothing new has been asked yet. Pick up from where the work stands and wait for the owner.'].join('\n'),
  );

  blocks.push('This is a summary of the conversation, not the conversation. The repository in front of you is the truth about the code; read it rather than trusting this about anything you can check.');
  return blocks.join('\n\n');
}

/**
 * Compose the payload that starts `targetAgent` where the current agent left
 * off. Deterministic: same inputs, same bytes out.
 */
export function composeHandoff(pack: ContextPack | null, thread: HandoffThread, targetAgent: AgentId): HandoffPayload {
  const { conversation, work } = storyLines(thread);

  // An UNANSWERED ask is the instruction, so it leaves the story and becomes its
  // own section, never trimmed away by the budget below. An ask the previous
  // agent already answered is history, not an instruction: it stays in the story
  // and this section says plainly that nothing new has been asked, rather than
  // sending the new agent off to redo finished work.
  const lastSpoken = [...thread.messages].reverse().find((m) => m.role === 'owner' || m.role === 'agent');
  const pending = lastSpoken?.role === 'owner' ? lastSpoken : null;
  const ask = pending ? clip(pending.content, MAX_ASK_CHARS) : null;
  const conversationWithoutAsk = pending ? conversation.slice(0, -1) : conversation;

  let kept = conversationWithoutAsk.slice(-MAX_CONVERSATION_LINES);
  let omitted = conversationWithoutAsk.length - kept.length;

  const sectionsFor = (lines: string[], dropped: number): HandoffSections => ({
    project: projectLines(pack),
    story: [...lines, ...work],
    standing: standingLines(thread),
    ask,
    omitted: dropped,
  });

  let sections = sectionsFor(kept, omitted);
  let text = renderPayload(thread, sections);

  // Trim oldest-first until it fits. The project, the standing state and the ask
  // are never trimmed — they are the whole reason the payload exists.
  while (estimateTokens(text) > MAX_PAYLOAD_TOKENS && kept.length > 0) {
    kept = kept.slice(1);
    omitted += 1;
    sections = sectionsFor(kept, omitted);
    text = renderPayload(thread, sections);
  }

  return {
    thread_id: thread.id,
    from_agent: thread.agent,
    to_agent: targetAgent,
    text,
    sections,
    estimated_tokens: estimateTokens(text),
    transcript_tokens: estimateTokens(thread.messages.map((m) => m.content).join('\n')),
  };
}
