/**
 * Same-origin fetch wrapper. The Express backend reads Clerk's session
 * cookie directly (clerkMiddleware()), so no bearer token wiring is
 * needed here — just make sure cookies ride along.
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`,
      res.status,
      body,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
