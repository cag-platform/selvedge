/**
 * WHY THE APP DIDN'T START, IN A SENTENCE A PERSON CAN ACT ON.
 *
 * This exists because of what the preview panel actually showed when an
 * imported project failed to boot:
 *
 *   I couldn't bring the preview up: the app didn't start: did not answer on
 *   :3000 rt: 5432 }]}> canvas-apparel-group@1.0.0 dev > NODE_ENV=development
 *   node server/index.js AggregateError [ECONNREFUSED]: at
 *   /workspace/app/node_modules/pg-pool/index.js:45:11 at
 *   process.processTicksAndRejections (node:internal/process/task_queues:104:5)
 *
 * A thousand characters of Node stack trace, in a product panel, for a problem
 * whose whole content is "it wants a database and there isn't one". Nobody
 * should ever read `processTicksAndRejections` in a piece of software they are
 * paying for. The Finish Pass ruled raw errors out and this was the last place
 * one was still getting through.
 *
 * WHAT THIS IS NOT. It is not a log parser that tries to understand programs.
 * It matches a short list of failures that actually happen when a real
 * repository meets a fresh checkout, and it says NOTHING when it recognises
 * nothing — because a confident wrong diagnosis is worse than an honest "I
 * couldn't tell", and this is exactly the kind of code that grows into guessing
 * if you let it. The raw log stays available; it just stops being the headline.
 *
 * Ordered most-specific first: a missing database and a missing environment
 * variable both look like a crash on boot, and the database is the one worth
 * naming.
 */

export type StartFailure = {
  /** What happened, in the owner's words. One sentence. */
  line: string;
  /** What to do about it, when there is something. */
  hint: string | null;
  /** Which pattern matched — for the record, and so tests name a case rather than a string. */
  kind: StartFailureKind;
};

export type StartFailureKind =
  | 'database'
  | 'missing_env'
  | 'port_in_use'
  | 'install_failed'
  | 'no_start'
  | 'crashed'
  | 'timeout'
  | 'unknown';

/** Ports whose refusal means "a service this app expects isn't here". */
const SERVICE_PORTS: Record<string, string> = {
  '5432': 'a PostgreSQL database',
  '3306': 'a MySQL database',
  '27017': 'a MongoDB database',
  '6379': 'a Redis server',
  '9200': 'an Elasticsearch server',
};

function serviceRefused(log: string): string | null {
  if (!/ECONNREFUSED/i.test(log)) return null;
  for (const [port, what] of Object.entries(SERVICE_PORTS)) {
    // Match the port as a port, not as any occurrence of the digits: a commit
    // sha or a byte count containing 5432 is not a database.
    if (new RegExp(`[:\\s]${port}\\b`).test(log)) return what;
  }
  return null;
}

/**
 * The variable a program said it was missing.
 *
 * Deliberately narrow. Every framework words this differently, and a regex
 * broad enough to catch them all catches half the English language too — so
 * this matches the few shapes that say a NAME, and returns null rather than
 * guessing at one.
 */
function missingEnvVar(log: string): string | null {
  const patterns = [
    /(?:Missing|missing) (?:required )?(?:environment variable|env var)[:\s"']*([A-Z][A-Z0-9_]{2,})/,
    /(?:environment variable|env var)[:\s"']*([A-Z][A-Z0-9_]{2,})[^A-Z0-9_]*(?:is )?(?:not set|required|missing|undefined)/i,
    /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b[^\n]*(?:undefined|is not defined|required)/,
    /\b([A-Z][A-Z0-9_]{2,}) is (?:not set|required|missing)\b/,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(log)?.[1];
    if (found) return found;
  }
  return null;
}

const SAYS_NOTHING = { line: '', hint: null, kind: 'unknown' as const };

/**
 * Read a failed start and say what went wrong.
 *
 * `log` is whatever the start command captured — the tail of the app's own
 * output. An empty log, or one this recognises nothing in, comes back as
 * `unknown` with no sentence, and the caller falls back to saying plainly that
 * it could not tell.
 */
export function diagnoseStartFailure(log: string): StartFailure {
  const text = log ?? '';

  const service = serviceRefused(text);
  if (service) {
    return {
      kind: 'database',
      line: `The app started and then stopped, because it expects ${service} and there isn't one in the sandbox.`,
      hint: 'Turn on a preview database for this project, or point the app at one it can reach from a preview environment variable.',
    };
  }

  const missing = missingEnvVar(text);
  if (missing) {
    return {
      kind: 'missing_env',
      line: `The app needs ${missing} to start, and this sandbox doesn't have it.`,
      hint: 'Add it to this project’s preview environment — those values stay out of the repository and out of the preview URL.',
    };
  }

  if (/EADDRINUSE/i.test(text)) {
    return {
      kind: 'port_in_use',
      line: 'Something was already holding the port the app wanted, so it stopped.',
      hint: 'Ask for the preview again — the old process is stopped first, and it usually comes up on the second try.',
    };
  }

  if (/(npm ERR!|ERR_PNPM|yarn error|Cannot find module|MODULE_NOT_FOUND|ERESOLVE)/i.test(text)) {
    return {
      kind: 'install_failed',
      line: "The app's dependencies didn't install, so it never got as far as starting.",
      hint: 'This is usually a lockfile that needs a specific package manager or Node version. The full output is below.',
    };
  }

  if (/(missing script|command not found|no such file or directory)/i.test(text)) {
    return {
      kind: 'no_start',
      line: "I couldn't find a way to start this app — there's no dev script, and nothing built to serve.",
      hint: 'A "dev" script in package.json, or a built index.html, is what a preview runs.',
    };
  }

  // A named exit with nothing else recognisable: it ran and died, and that is
  // all we honestly know.
  if (/(ELIFECYCLE|exited with|Segmentation fault|FATAL ERROR|heap out of memory)/i.test(text)) {
    return {
      kind: 'crashed',
      line: 'The app started and then stopped on its own.',
      hint: 'What it printed on the way out is below — that usually says which piece it was unhappy about.',
    };
  }

  if (/did not answer on/i.test(text)) {
    return {
      kind: 'timeout',
      line: "The app never finished starting, so there was nothing to show yet.",
      hint: 'Some apps take longer than the ninety seconds a preview waits. Ask again and it may already be up.',
    };
  }

  return SAYS_NOTHING;
}

/**
 * The whole message for the panel: what happened, what to do, and never the
 * stack trace.
 *
 * The raw output does not disappear — it goes to the server log and stays
 * available behind the full record. What changes is that it stops being the
 * first thing a person reads.
 */
export function previewFailureMessage(log: string): string {
  const found = diagnoseStartFailure(log);
  if (found.kind === 'unknown') {
    // The honest version of "I don't know", which is a real answer and not a
    // failure to have one.
    return "I couldn't bring the preview up, and I couldn't tell why from what the app printed. The full output is in the record.";
  }
  return found.hint ? `${found.line} ${found.hint}` : found.line;
}
