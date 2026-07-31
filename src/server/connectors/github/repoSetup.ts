/**
 * Borrow-and-return: create the customer's app repo in THEIR GitHub account,
 * then immediately hand back the broad key (MIGRATION-CENTER §1).
 *
 * GitHub Apps cannot create repos in a personal account — that needs an OAuth
 * user token with the `repo` scope, which can read every one of the customer's
 * private repos. We hold that power for exactly one action and then revoke our
 * own grant. The single most important property, enforced here with try/
 * finally: the key is returned whether the repo creation succeeds OR fails. A
 * broad token must never be left live because something threw.
 *
 * The GitHub calls are behind an injected interface so this orchestration is
 * testable without the network and so the real HTTP client lives in one place.
 */

export interface GithubOAuthOps {
  /** Exchange the OAuth callback code for a user access token (broad `repo` scope). */
  exchangeCodeForToken(code: string): Promise<string>;
  /** Create ONE private repo in the authenticated user's account. Returns its full name (owner/repo). */
  createUserRepo(token: string, name: string): Promise<{ fullName: string; htmlUrl: string }>;
  /** Revoke this app's OAuth grant for the user — DELETE /applications/{client_id}/grant. */
  revokeGrant(token: string): Promise<void>;
}

export type RepoSetupAct = {
  act: 'key_borrowed' | 'door_built' | 'key_returned' | 'key_return_failed' | 'door_build_failed';
  at: Date;
  detail?: string;
};

export type RepoSetupReceipt = {
  ok: boolean;
  /** The repo, when it was created. */
  repo?: { fullName: string; htmlUrl: string };
  /** True only when the broad grant was confirmed revoked. */
  keyReturned: boolean;
  /** The ordered acts, for the ledger and for the plain-language "here's the receipt". */
  acts: RepoSetupAct[];
  /** Present when something went wrong, in plain words for the customer. */
  error?: string;
};

/**
 * Run the whole sequence. Never throws — returns a receipt describing exactly
 * what happened, because the customer is owed the truth about a flow that
 * briefly held broad access to their account.
 *
 * `now` is injected so the receipt's timestamps are testable.
 */
export async function borrowCreateReturn(
  ops: GithubOAuthOps,
  code: string,
  repoName: string,
  now: () => Date = () => new Date(),
): Promise<RepoSetupReceipt> {
  const acts: RepoSetupAct[] = [];
  let token: string;

  // 1. Borrow the key. If we can't even get the token, nothing was granted to
  //    hold onto — report and stop.
  try {
    token = await ops.exchangeCodeForToken(code);
    acts.push({ act: 'key_borrowed', at: now() });
  } catch {
    return {
      ok: false,
      keyReturned: false,
      acts,
      error: "I couldn't connect to your GitHub — nothing was changed. Try again.",
    };
  }

  // 2. Build the one door, and 3. ALWAYS return the key — even if building
  //    threw. This is the guarantee: the broad grant does not outlive step 2.
  let repo: { fullName: string; htmlUrl: string } | undefined;
  let buildError: string | undefined;
  try {
    repo = await ops.createUserRepo(token, repoName);
    acts.push({ act: 'door_built', at: now(), detail: repo.fullName });
  } catch {
    buildError = "I couldn't set up your app's new home. Nothing else was touched.";
    acts.push({ act: 'door_build_failed', at: now() });
  } finally {
    // The key is returned no matter what happened above.
    try {
      await ops.revokeGrant(token);
      acts.push({ act: 'key_returned', at: now() });
    } catch {
      // We built (or tried to), but could not auto-revoke. This is the one
      // case where the customer must act: we tell them plainly rather than
      // pretending the key came back.
      acts.push({ act: 'key_return_failed', at: now() });
    }
  }

  const keyReturned = acts.some((a) => a.act === 'key_returned');

  if (buildError) {
    return { ok: false, keyReturned, acts, error: buildError };
  }
  if (!keyReturned) {
    return {
      ok: false,
      ...(repo ? { repo } : {}),
      keyReturned: false,
      acts,
      error:
        "Your app's home is set up, but I couldn't hand back the broad access automatically. " +
        'Please remove Selvedge from your GitHub authorized apps — I only needed it for that one step.',
    };
  }

  return { ok: true, ...(repo ? { repo } : {}), keyReturned: true, acts };
}
