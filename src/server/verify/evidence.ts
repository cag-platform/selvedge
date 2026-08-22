/**
 * What actually changed — the evidence an independent grader judges.
 *
 * The obvious place to get this is the sandbox, and it isn't there: the runner
 * deletes the sandbox in a `finally` that fires before verification runs
 * (runner/run.ts), so `VerifyContext.sandbox` has never been populated by
 * anyone and there is nothing left to populate it with. Nor does the run leave
 * a trace behind — the agent's own note is dropped by the card machine, and the
 * card's acts after a clean run are two constant strings.
 *
 * But the agent pushes a real branch. `runner/daytona/provider.ts` commits the
 * work to `selvedge/<card id>` and pushes it to the customer's own repo, so the
 * diff is durable and reachable over HTTP long after the sandbox is gone. That
 * is what this reads.
 *
 * The alternative — capturing a diff during the run — would mean opening the
 * runner and the pure state machine, which is the most safety-critical file in
 * the codebase, to obtain something GitHub is already holding.
 *
 * Plain fetch with a bearer header, mirroring connectors/github/newRepo.ts: the
 * token is sent and never logged, never echoed into an error, never returned.
 */

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/** The branch the card's work was pushed to. Mirrors provider.ts's naming. */
export function reviewBranchFor(cardId: string): string {
  return `selvedge/${cardId}`;
}

/**
 * Bounds. A grader reading a 4,000-line refactor costs real money and, past a
 * point, judges worse rather than better. Truncation is disclosed to the grader
 * rather than hidden, so it can answer "can't tell" instead of confidently
 * judging a fragment as if it were the whole change.
 */
export const MAX_FILES = 40;
export const MAX_DIFF_CHARS = 24_000;

export type ChangeEvidence = {
  /** Every path that changed, even when the patch bodies were truncated. */
  paths: string[];
  /** Unified patch text, bounded. */
  diff: string;
  truncated: boolean;
};

type CompareFile = { filename?: unknown; status?: unknown; patch?: unknown };

export type EvidenceDeps = {
  /** Injected so the whole thing is testable without GitHub. */
  fetchCompare?: (repoFullName: string, base: string, head: string, accessToken?: string) => Promise<CompareFile[] | null>;
  token?: string;
};

async function defaultFetchCompare(
  repoFullName: string,
  base: string,
  head: string,
  accessToken?: string,
): Promise<CompareFile[] | null> {
  // No token, no call: an unauthenticated compare against a private repo 404s
  // indistinguishably from "no branch", and "we couldn't look" must never be
  // graded as "nothing changed". The caller passes the org's own credential;
  // the env fallback is for deployments with no GitHub app configured.
  const token = accessToken?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;

  const url = `https://api.github.com/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...API_HEADERS, Authorization: `Bearer ${token}` } });
  } catch {
    // Unreachable GitHub is "no evidence", not an error to surface: the caller
    // degrades to could_not_run, which is the honest outcome.
    return null;
  }
  // 404 is the ordinary case for a card whose agent changed nothing — no branch
  // was ever pushed. Not a failure, just nothing to grade.
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { files?: unknown } | null;
  return Array.isArray(body?.files) ? (body.files as CompareFile[]) : null;
}

/** Shape a compare response into bounded evidence, or null when there is nothing to judge. */
export function shapeEvidence(files: CompareFile[]): ChangeEvidence | null {
  const named = files.filter((f): f is CompareFile & { filename: string } => typeof f.filename === 'string');
  if (named.length === 0) return null;

  // Every path is reported even when patch bodies are dropped — knowing that 200
  // files changed is itself evidence, and a grader should see the scope of what
  // it is being asked to judge.
  const paths = named.map((f) => f.filename);

  let truncated = named.length > MAX_FILES;
  const parts: string[] = [];
  let used = 0;

  for (const file of named.slice(0, MAX_FILES)) {
    const patch = typeof file.patch === 'string' ? file.patch : '';
    // A binary file, or one GitHub declined to diff, has no patch. Say so
    // rather than omitting it silently.
    const header = `--- ${file.filename}${patch ? '' : ' (no textual diff available)'}`;
    const block = patch ? `${header}\n${patch}` : header;
    if (used + block.length > MAX_DIFF_CHARS) {
      truncated = true;
      break;
    }
    parts.push(block);
    used += block.length;
  }

  return { paths, diff: parts.join('\n\n'), truncated };
}

/**
 * The evidence for one card, or null when there is none to be had — no branch,
 * no repo, GitHub unreachable. Null must land the acceptance check on
 * `could_not_run`; a grader with no evidence has nothing to judge and must
 * never be asked to guess.
 */
export async function fetchChangeEvidence(
  repoFullName: string,
  cardId: string,
  baseBranch = 'main',
  deps: EvidenceDeps = {},
): Promise<ChangeEvidence | null> {
  const fetchCompare = deps.fetchCompare ?? defaultFetchCompare;
  const files = await fetchCompare(repoFullName, baseBranch, reviewBranchFor(cardId), deps.token).catch(() => null);
  if (!files) return null;
  return shapeEvidence(files);
}

/** The evidence as the grader reads it — paths first, then the bounded patch. */
export function renderEvidence(evidence: ChangeEvidence): string {
  const lines = [`Files changed (${evidence.paths.length}):`, ...evidence.paths.map((p) => `  ${p}`)];
  if (evidence.truncated) {
    lines.push(
      '',
      'NOTE: this diff is truncated — you are not seeing every change. If the part you can see does not settle the question, answer cannot_tell.',
    );
  }
  lines.push('', evidence.diff);
  return lines.join('\n');
}
