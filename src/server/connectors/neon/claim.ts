/**
 * MAKE THE DATABASE THEIRS — Neon's claimable-project flow, driven by us.
 *
 * Provisioned databases live on Selvedge's Neon account (see client.ts): zero
 * signup at go-live, and the subscription pays for them. The cost of that
 * convenience is custody — and the product's whole posture is that the
 * customer can fire Selvedge and everything keeps running. So the way out is
 * a first-class button, not a support ticket.
 *
 * Neon built exactly this: a transfer request is minted against the project
 * (POST /projects/{id}/transfer_requests), and a claim URL puts the ACCEPT in
 * the owner's hands — they open it, sign in to their own Neon account (making
 * one on the spot if needed), and the project moves. Connection strings do not
 * change, so the running app never notices its database changed hands.
 *
 * WHAT SELVEDGE KEEPS: nothing. After a claim the project is theirs, billed to
 * them, visible in their console — and the DATABASE_URL already set on their
 * host keeps working, so nothing needs re-deploying. The Neon door in the UI
 * finally points at a console they can actually open.
 *
 * The request expires (ttl below) — a claim link is a capability, and a
 * capability that lives forever in a chat log is a leak with a delay on it.
 */

const ENDPOINT = 'https://console.neon.tech/api/v2/projects';

/** A week: long enough to claim at leisure, short enough that a pasted-somewhere link dies. */
export const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

export type TransferRequest = { id: string; expiresAt: string };

export class NeonClaimError extends Error {}

export async function createTransferRequest(neonProjectId: string, ttlSeconds = CLAIM_TTL_SECONDS): Promise<TransferRequest> {
  const key = process.env.NEON_API_KEY?.trim();
  if (!key) throw new NeonClaimError('no database provider is configured (NEON_API_KEY is not set)');

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(neonProjectId)}/transfer_requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  } catch (err) {
    throw new NeonClaimError(`could not reach Neon (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as { id?: string; expires_at?: string; message?: string } | null;
  if (!res.ok || !body?.id || !body.expires_at) {
    // 404 here usually means the project is not on Selvedge's account any
    // more — i.e. it was already claimed, which is a fine state to discover.
    if (res.status === 404) throw new NeonClaimError('Neon does not show that database on Selvedge’s account — it may already be yours.');
    throw new NeonClaimError(`Neon responded ${res.status}${body?.message ? `: ${body.message}` : ''}`);
  }
  return { id: body.id, expiresAt: body.expires_at };
}

/** The URL the OWNER opens — the accept lives in their browser, with their Neon session. */
export function claimUrl(neonProjectId: string, transferRequestId: string, redirectUrl?: string): string {
  const ru = redirectUrl ? `&ru=${encodeURIComponent(redirectUrl)}` : '';
  return `https://console.neon.tech/app/claim?p=${encodeURIComponent(neonProjectId)}&tr=${encodeURIComponent(transferRequestId)}${ru}`;
}
