import type { Card } from '../../cards/types.js';
import type { AgentStepResult } from '../types.js';
import { MAX_TOOL_EVENTS, MAX_INPUT_CHARS, MAX_NOTE_CHARS, type ToolEvent } from '../../../shared/types/toolEvent.js';

/**
 * The pure parts of the agent step — everything that can be decided without a
 * sandbox: the prompt handed to the Claude Code CLI, the shell command that runs
 * it, parsing the CLI's stream-json output for the final result, and mapping that
 * result to the runner's AgentStepResult (cost in cents, done, note). Ported from
 * Toile's proven runner; the network parts live in provider.ts.
 */

/** The sandbox working directory (matches the Toile clone target). */
export const WORKDIR = '/workspace/app';
export const PATH_PREFIX = 'export PATH="$HOME/.npm-global/bin:$PATH" &&';

/** Shell-single-quote a value safely (Toile's shellQuote). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The instruction the agent works from. It is the owner's ask, framed so the
 * agent edits the repo in place and keeps the change focused — no ceremony, no
 * deploy (Selvedge ships separately, after verification).
 */
export function buildAgentPrompt(card: Card): string {
  const ask = card.trigger === 'request' ? card.title : `${card.title}. ${card.proposal}`;
  return [
    `You are making one focused change to a live application, in this repository.`,
    `The owner asked: "${ask}".`,
    `Make just that change, cleanly and minimally. Do not start a dev server or deploy —`,
    `only edit the code. When you are done, make sure the project still builds if it has a build step.`,
  ].join(' ');
}

/**
 * WHO THE AGENT IS BUILDING FOR — the standing rules, sent every turn.
 *
 * Without these the agent is a bare CLI holding one sentence, and it falls back
 * to what it was trained on: talking to a developer. It finishes a database
 * feature and writes "Next Steps for You — create a Railway project, run npm
 * install, run pip install psycopg2-binary, copy your DATABASE_URL into .env".
 * The person reading that has no terminal and does not read code. A handoff
 * they cannot act on is worse than no handoff: it looks like the work is done
 * when it is actually parked.
 *
 * These go through --append-system-prompt rather than a CLAUDE.md in the repo
 * on purpose. A file at /workspace/app would show up in `git status
 * --porcelain` — which is how the workshop decides there is work ready to ship
 * — and would then be committed into the customer's own repository by
 * `git add -A`. The rules are ours; they must never end up in their code.
 */
const AUDIENCE_RULES = [
  'You are building software inside Selvedge, for an owner who does not read code and has no terminal.',
  'They will never run a command, install anything, edit a config file, or copy a value between services.',
  '',
  'Because of that:',
  '- NEVER end with instructions for them to run. No "run npm install", no "create a Railway project", no',
  '  "copy your DATABASE_URL into .env", no setup checklists of any kind. If a step is needed, either do it',
  '  yourself now or say plainly that it is not done and why.',
  '- Do not write README, SETUP, DEPLOY or similar guide files unless you are explicitly asked to. They are',
  '  written for developers, and nobody here will read them.',
  '- Explain what you did in plain English, in the owner\'s own words for their app. A short paragraph, not a',
  '  report. No file paths, framework names, or command output unless they asked for that detail.',
  '- Never claim something works when you have not seen it work. If you could not finish or could not check,',
  '  say so in one plain sentence. A confident false all-clear is the worst thing you can produce here.',
  '',
  'How this environment works, so you do not duplicate it or fight it:',
  `- The project is a git repository at ${WORKDIR}. Edit it in place. Do not commit or push — the owner ships`,
  '  deliberately from Selvedge, after they have looked at it.',
  '- Selvedge runs the app itself to show the owner a live preview: it installs dependencies and starts the app',
  '  on port 3000. So the app must either have a `dev` script that listens on port 3000 and binds 0.0.0.0, or',
  '  build to a static `dist/`. You do not need to tell anyone to install or start anything.',
  '- Anything secret or environment-specific (a database URL, an API key) must be read from environment',
  '  variables, never hard-coded and never invented. Record every variable the app needs in `.env.example`',
  '  with a short comment saying what each one is for.',
  '- Read configuration lazily, on first use — not at import time. An app that throws on startup because one',
  '  variable is missing shows the owner a blank screen instead of their app.',
  '- If the app genuinely needs something only the owner can provide — an account with another service, a paid',
  '  key — say so in ONE plain sentence naming what it is and what it is for. Do not write a guide for getting it.',
].join('\n');

/** The build-mode addition: the setup work is yours, not theirs. */
const BUILD_RULES = [
  '',
  'You have a full working machine here, with sudo. Installing packages, standing up a database, creating and',
  'migrating its schema, seeding data, and running the tests are all YOUR job, done now, in this sandbox — not',
  'steps to hand over.',
  '',
  'In particular: if the app needs a database, install and start one here, create the schema, seed it, and point',
  'the app at it through the environment. The owner has to be able to SEE the thing working in the preview; an',
  'app that cannot start because nothing gave it a database is not finished. If a piece of this genuinely cannot',
  'be done here, name that one piece plainly and carry on with the rest.',
].join('\n');

/** The standing rules for a turn. Plan turns leave out the "do the work now" half. */
export function agentRules(mode: 'build' | 'plan' = 'build'): string {
  return mode === 'plan' ? AUDIENCE_RULES : AUDIENCE_RULES + BUILD_RULES;
}

/**
 * The remote command: run one Claude Code turn to completion, streaming
 * stream-json so we can read the final cost and success. `--dangerously-skip-
 * permissions` is safe here because the whole thing runs inside a throwaway
 * sandbox that holds only this one app's code.
 */
export function claudeCommand(
  prompt: string,
  model = 'sonnet',
  resumeSessionId?: string | null,
  mode: 'build' | 'plan' = 'build',
  /**
   * Whose account this turn runs on, and which variable the CLI reads it from.
   * Not optional in practice — `driverFor` will not build a driver without it —
   * but typed optional so the command can still be rendered for a test that
   * cares about the arguments rather than the credential.
   *
   * The variable name comes from builderAuth.ts and is NEVER assumed here: a
   * subscription token in ANTHROPIC_API_KEY doesn't fail loudly, it fails as
   * "no credentials found" inside a sandbox the owner is already paying for.
   */
  auth?: { envVar: string; secret: string } | null,
): string {
  const args = [
    'claude',
    '-p',
    shellQuote(prompt),
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    // Who this is for and how this environment works. Appended rather than
    // written into the repo, so the rules never reach the customer's code.
    '--append-system-prompt',
    shellQuote(agentRules(mode)),
    '--model',
    model,
  ];
  // Iteration: --resume continues the same conversation, so "now make it
  // darker" builds on the last change instead of starting from scratch.
  if (resumeSessionId) args.push('--resume', shellQuote(resumeSessionId));
  // Prefixed on the command rather than set on the sandbox, exactly as Codex's
  // key is. One turn, one credential, gone when the process exits — so a
  // sandbox that outlives a rotated key doesn't keep using the old one, and a
  // sandbox belonging to one org never holds another's secret.
  const credential = auth?.secret ? `${auth.envVar}=${shellQuote(auth.secret)} ` : '';
  return `${PATH_PREFIX} cd ${WORKDIR} && ${credential}${args.join(' ')}`;
}

export type ResultEvent = {
  subtype: string;
  totalCostUsd: number | null;
  /** The Claude Code session id — saved so the next turn can --resume it. */
  sessionId: string | null;
  isError: boolean;
};

/**
 * Extract the final `result` event from the CLI's stream-json stdout. The output
 * is newline-delimited JSON; the last `type: "result"` line carries the cost and
 * the success flag. Returns null when no result line is present (a crashed or
 * killed run) — the caller treats that as "no confirmed work", never a success.
 */
export function parseResult(stdout: string): ResultEvent | null {
  let found: ResultEvent | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'result') {
      found = {
        subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
        totalCostUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        sessionId: typeof event.session_id === 'string' ? event.session_id : null,
        isError: event.is_error === true || event.subtype !== 'success',
      };
    }
  }
  return found;
}

/**
 * The agent's own words from the stream — every assistant text block, joined.
 * This is what the chat thread shows as the agent's reply: its actual narrative
 * of what it did, not a canned line. Empty when the stream carried none.
 */
export function parseAssistantText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== 'assistant') continue;
    const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * The flight recorder's parser: every tool_use in the stream, as a structured
 * ToolEvent — full-enough inputs (bounded per field), plus the OUTCOME from the
 * paired tool_result, which no parser read before this existed. Whether an edit
 * applied or a test passed lives in `type: "user"` events; ignoring them meant
 * the record could show work but never whether the work worked.
 *
 * Bounded by construction: per-field input caps, a failed result's note capped,
 * and at most MAX_TOOL_EVENTS events with a truncated flag — this is a durable
 * jsonb record, not a log archive.
 */
export function parseToolEvents(stdout: string): { tools: ToolEvent[]; truncated: boolean } {
  const tools: ToolEvent[] = [];
  const byId = new Map<string, ToolEvent>();
  let truncated = false;

  const cap = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === 'assistant') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        if (tools.length >= MAX_TOOL_EVENTS) {
          truncated = true;
          continue;
        }
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const id = typeof block.id === 'string' ? block.id : `tool_${tools.length}`;
        const rawInput = (block.input ?? {}) as Record<string, unknown>;
        // Keep the inputs an owner (or a future analyst) would actually read;
        // huge fields (old_string/new_string/content) ride bounded.
        const input: Record<string, string> = {};
        for (const key of ['file_path', 'command', 'pattern', 'description', 'url', 'old_string', 'new_string', 'content']) {
          const v = rawInput[key];
          if (typeof v === 'string' && v !== '') input[key] = cap(v, MAX_INPUT_CHARS);
        }
        const tool: ToolEvent = {
          id,
          name,
          detail: describeToolUse(name, rawInput),
          ...(Object.keys(input).length ? { input } : {}),
        };
        tools.push(tool);
        byId.set(id, tool);
      }
    }

    // tool_result blocks ride user events: the outcome half of the pair.
    if (event.type === 'user') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const useId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const tool = byId.get(useId);
        if (!tool) continue;
        const failed = block.is_error === true;
        tool.ok = !failed;
        if (failed) {
          const content = block.content;
          const text =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .map((c) => (typeof (c as Record<string, unknown>).text === 'string' ? ((c as Record<string, unknown>).text as string) : ''))
                    .join(' ')
                : '';
          if (text.trim() !== '') tool.note = cap(text.trim(), MAX_NOTE_CHARS);
        }
      }
    }
  }

  return { tools, truncated };
}

/** The owner-readable line for one tool use — the live feed's vocabulary. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  const short = (v: string | null, n: number) => (v && v.length > n ? `${v.slice(0, n - 1)}…` : v ?? '');
  const rel = (p: string | null) => (p ? p.replace(/^\/workspace\/app\//, '') : '');
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${rel(str('file_path')) || 'a file'}`;
    case 'Read':
      return `Reading ${rel(str('file_path')) || 'a file'}`;
    case 'Bash':
      return `Running: ${short(str('command'), 70)}`;
    case 'Glob':
    case 'Grep':
      return `Searching for ${short(str('pattern'), 50)}`;
    case 'TodoWrite':
      return 'Updating its plan';
    default:
      return `Using ${name}`;
  }
}

/**
 * Compact, owner-readable lines for what the agent is doing right now — one per
 * tool use, in plain words ("Editing src/App.tsx", "Running: npm test"). This is
 * the live activity feed: parsed incrementally from the stream-json log while
 * the turn runs, so the owner watches the work, not a spinner. A projection of
 * parseToolEvents, so the feed and the durable record can never disagree.
 */
export function parseToolActivity(stdout: string): string[] {
  return parseToolEvents(stdout).tools.map((t) => t.detail);
}

/**
 * Map a finished Claude turn to the runner's step result. One turn is the whole
 * change, so `done` is always true — the runner then hands off to verification,
 * which is where an incomplete or wrong change is caught. The cost is real
 * spend and drives the cap and checkpoints. A missing or errored result records
 * whatever cost was reported (often none) and lets verification judge the rest.
 */
export function resultToStep(result: ResultEvent | null): AgentStepResult {
  const spentCents = Math.max(0, Math.round((result?.totalCostUsd ?? 0) * 100));
  if (!result) {
    return { spentCents, done: true, note: 'the agent did not return a result — verification will judge what, if anything, changed' };
  }
  return {
    spentCents,
    done: true,
    note: result.isError ? `the agent reported a problem (${result.subtype})` : 'made the change',
  };
}
