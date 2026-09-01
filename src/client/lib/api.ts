/**
 * Same-origin fetch wrapper. The Express backend reads Clerk's session
 * cookie directly (clerkMiddleware()), so no bearer token wiring is
 * needed here — just make sure cookies ride along.
 *
 * AND THE ONE PLACE A FAILURE BECOMES A SENTENCE.
 *
 * There are forty-odd places in this client that do
 * `e instanceof Error ? e.message : "that didn't go through"` and put the
 * result on screen. That pattern is right — the server's refusals are written
 * sentences, designed with the surface that shows them, and passing one
 * through verbatim is exactly what should happen.
 *
 * What was wrong is what happened when there was NO sentence to pass through.
 * Three ways that used to end up in front of a person:
 *
 *   - the network is down, and `fetch` throws its own `TypeError: Failed to
 *     fetch` — which went straight to the screen;
 *   - the server answered but sent no `{ error }` body, so the message became
 *     "502 Bad Gateway", a status code shown to somebody who does not have one;
 *   - the response was HTML rather than JSON (a proxy page, or the SPA
 *     catch-all answering an /api path that doesn't exist), so `res.json()`
 *     threw a parse error about an unexpected `<`.
 *
 * Fixing that at forty call sites would be forty chances to miss one. It is
 * fixed HERE, once: every rejection from this module carries a sentence a
 * person can read and act on, so every existing call site keeps working and
 * none of them can leak. The status is still on the error for the surfaces
 * that branch on it (409 ceiling, 409 stale decision, 401 key).
 */

/**
 * A failed call, with the server's own words AND the rest of what it said.
 * Some refusals are not dead ends — the stale-decision guard replies 409 with
 * what is stale and by how much, so the surface can offer the way through
 * instead of only reporting the wall. Extends Error, so every existing
 * `e instanceof Error ? e.message` site keeps working unchanged.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * What to say when the server did not say anything itself.
 *
 * Each of these answers the two questions a person actually has — what
 * happened, and what to do — because "500" answers neither. They are
 * deliberately about the situation rather than the protocol: nobody outside
 * this file needs to learn what a 502 is to use Selvedge.
 *
 * `status === 0` is our own marker for "the request never arrived anywhere".
 */
export function sayFailure(status: number): string {
  if (status === 0) return "Connection lost. Retry.";
  if (status === 401 || status === 403) return 'Your session has expired. Sign in again and this will work.';
  if (status === 404) return "That isn't here any more — it may have been renamed or removed.";
  if (status === 413) return "That's larger than this can take in one go.";
  if (status === 429) return 'That went too fast for the service behind it. Give it a moment and try again.';
  if (status === 503) return 'Selvedge is starting up or briefly down. Try again in a minute — nothing was lost.';
  if (status >= 500) return "Something went wrong. Retry.";
  return "That didn't go through.";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-selvedge-surface': productSurface(), ...init?.headers },
      ...init,
    });
  } catch {
    // `fetch` only rejects when the request never happened: no network, DNS
    // failure, the tab going offline mid-flight. Its own message is a
    // `TypeError` about fetching, which is true and useless.
    throw new ApiError(sayFailure(0), 0, {});
  }

  if (!res.ok) {
    // A body that isn't JSON is itself a failure mode — a proxy's HTML error
    // page, or the SPA catch-all answering an /api path. Either way there is
    // no sentence in there, so don't pretend to look for one.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The server's own words when it wrote some; ours when it didn't. Never
    // the status line, which is the thing that used to reach the screen.
    const sentence = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : sayFailure(res.status);
    throw new ApiError(sentence, res.status, body);
  }

  // A success with nothing in it is a success. `res.json()` rejects on an
  // empty body, which used to surface as a parse error on a call that worked.
  if (res.status === 204) return undefined as T;

  // A 200 that isn't JSON is the same shape of problem as a non-JSON failure,
  // and would otherwise surface as a parse error about an unexpected character.
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("The server's answer came back in a form I couldn't read.", res.status, {});
  }
}

/**
 * Multipart, so the browser sets its own boundary header — everything else
 * (the sentence-or-sayFailure rule, ApiError carrying the body) matches
 * request() above, so an upload failure reads like any other failure.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'x-selvedge-surface': productSurface() }, body: form });
  } catch {
    throw new ApiError(sayFailure(0), 0, {});
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const sentence = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : sayFailure(res.status);
    throw new ApiError(sentence, res.status, body);
  }
  return body as T;
}

function productSurface(): 'desktop_web' | 'responsive_web' {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'responsive_web' : 'desktop_web';
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  // PUT for the routes that set a whole thing rather than nudging one field —
  // a project's preview environment is written as a set, not patched.
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
