/**
 * WHAT THE SIGN-IN ALREADY KNOWS — the "bring everything" half of GitHub login.
 *
 * When somebody signs in with GitHub, Clerk holds the OAuth token that proved
 * who they are. This module borrows it — server-side, via Clerk's backend API,
 * never exposed to a browser — to ask GitHub one question: who is this, and
 * where do they build? The answer seeds the arrival moment: "you're
 * {login} — here's what you've got, pick what Selvedge should watch."
 *
 * SCOPE HONESTY, STATED ONCE AND DESIGNED AROUND. The sign-in token carries
 * identity scopes only (user:email, read:user) — deliberately, because `repo`
 * scope is all-or-nothing across an account and that bluntness is what the
 * GitHub App exists to avoid. With identity scopes, GitHub's repo listing
 * shows PUBLIC repos only. So this is a greeting and a preview, not the
 * picker: the real selection happens on GitHub's own App-install page, which
 * lists everything (private included) with GitHub's own consent UI. The UI
 * copy says exactly that, so nobody reads a public-only list as "Selvedge
 * can't see my private repos ever".
 *
 * The token is used for two GETs and discarded — sent as a header only, never
 * logged, never persisted, never returned by any API here.
 */

export type PersonalRepo = { full_name: string; private: boolean; pushed_at: string | null };
export type PersonalGithub = { login: string; repos: PersonalRepo[] };

export class PersonalGithubError extends Error {}

const CLERK_API = 'https://api.clerk.com/v1';
const GITHUB_API = 'https://api.github.com';

/**
 * The user's GitHub OAuth token, from Clerk's wallet. Null is a normal answer,
 * not a failure: it means this person signed in with email or Google, and the
 * arrival card simply does not apply to them.
 */
export async function clerkGithubToken(userId: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY?.trim();
  if (!key) return null;

  let res: Response;
  try {
    res = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}/oauth_access_tokens/oauth_github`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  // Clerk has shipped this endpoint as both a bare array and a `{data: []}`
  // envelope across API versions — accept either shape.
  const body = (await res.json().catch(() => null)) as unknown;
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown[] } | null)?.data ?? []);
  const first = rows[0] as { token?: unknown } | undefined;
  return typeof first?.token === 'string' && first.token !== '' ? first.token : null;
}

/** Who this token belongs to on GitHub, and their most recently pushed repos. */
export async function personalGithub(token: string): Promise<PersonalGithub> {
  const get = async (path: string) => {
    try {
      return await fetch(`${GITHUB_API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
    } catch (err) {
      throw new PersonalGithubError(`could not reach GitHub (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const userRes = await get('/user');
  if (!userRes.ok) throw new PersonalGithubError(`GitHub responded ${userRes.status}`);
  const user = (await userRes.json()) as { login?: string };
  if (typeof user.login !== 'string' || user.login === '') {
    throw new PersonalGithubError('GitHub answered without a login');
  }

  // Sorted by last push — the repos somebody actually works in, first. A
  // failure here degrades to a greeting with no list rather than failing the
  // whole answer: knowing WHO arrived is still worth having.
  const reposRes = await get('/user/repos?sort=pushed&per_page=100');
  const raw = reposRes.ok ? ((await reposRes.json().catch(() => [])) as unknown) : [];
  const repos: PersonalRepo[] = (Array.isArray(raw) ? raw : [])
    .filter((r): r is { full_name: string; private?: boolean; pushed_at?: string | null } => {
      return typeof (r as { full_name?: unknown }).full_name === 'string';
    })
    .map((r) => ({ full_name: r.full_name, private: r.private === true, pushed_at: r.pushed_at ?? null }));

  return { login: user.login, repos };
}
