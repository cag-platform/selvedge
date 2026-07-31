import { Router, type Request } from 'express';
import { and, eq, gt, gte, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { digests, narrations, orgs, trustIncidents } from '../../db/schema/index.js';
import { localDateString, yesterdayBoundsUtc } from '../../digest/timezone.js';
import { composeDigestForOrg } from '../../digest/compose.js';
import { getPack } from '../../packs/store.js';
import type { ComposeDepsResolver } from '../../llm/factory.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Today page (deliverable 8): today's digest + any narration since it was
 * composed. `resolveComposeDeps` builds this org's compose deps from its own
 * fuel at request time — so a compose-now runs on the customer's key, not a
 * shared one. Omitted → mechanical brief (the deterministic path).
 */
export function createTodayRouter(db: Db, resolveComposeDeps?: ComposeDepsResolver) {
  const router = Router();

  // On-demand composition — same idempotent path the 7:00 cron takes, so
  // pressing it twice (or the cron firing later) never double-writes a day.
  router.post(
    '/api/today/compose',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const llmDeps = resolveComposeDeps ? await resolveComposeDeps(orgId) : undefined;
      const digest = await composeDigestForOrg(db, orgId, new Date(), llmDeps);
      res.json({ digest });
    }),
  );

  router.get(
    '/api/today',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const now = new Date();
      const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
      const timezone = org?.timezone ?? 'UTC';
      const todayStr = localDateString(now, timezone);

      const [digest] = await db
        .select()
        .from(digests)
        .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, todayStr)))
        .limit(1);

      // Before the first digest of the day composes (e.g. very first day, or
      // simply before 7am local), still surface anything that's happened
      // since local midnight — a connector going auth_failed shouldn't wait
      // for a digest to exist before it's visible (acceptance gate 6).
      const since = digest ? digest.createdAt : yesterdayBoundsUtc(timezone, now).end;
      const postDigestRows = await db
        .select()
        .from(narrations)
        .where(and(eq(narrations.orgId, orgId), digest ? gt(narrations.createdAt, since) : gte(narrations.createdAt, since)));

      // Each live event is rendered as a situation card, and the card's
      // register (how much technical detail rides along) is the project's own
      // voice.detail_level — the same rule the digest obeys. Resolve it once
      // per distinct project so a plain_only owner never sees the mono line,
      // and a technical_forward owner sees it inline instead of collapsed.
      const projectIds = [...new Set(postDigestRows.map((n) => n.projectId).filter((id): id is string => Boolean(id)))];
      const packByProject = new Map(
        await Promise.all(
          projectIds.map(async (pid) => [pid, await getPack(db, orgId, pid)] as const),
        ),
      );
      const postDigestEvents = postDigestRows.map((n) => {
        const pack = n.projectId ? packByProject.get(n.projectId) : null;
        return {
          ...n,
          // Tray events (no project yet) fall back to the expandable middle
          // register — never plain_only, so their "why" is at least reachable.
          detail_level: pack?.voice.detail_level ?? 'plain_expandable',
          project_name: pack?.identity.name ?? null,
        };
      });

      // Enrich attention items with their narration's verdict + technical
      // line so the client can draw the edge (verdict -> status is fixed
      // vocabulary) and offer the mono register without a second request.
      let enriched = digest ?? null;
      if (digest) {
        const sections = digest.sections as { attention?: Array<{ narration_id: string }> };
        const ids = (sections.attention ?? []).map((a) => a.narration_id);
        if (ids.length > 0) {
          const rows = (await db.select().from(narrations).where(eq(narrations.orgId, orgId))).filter((n) => ids.includes(n.id));
          const byId = new Map(rows.map((n) => [n.id, n]));
          enriched = {
            ...digest,
            sections: {
              ...(digest.sections as Record<string, unknown>),
              attention: (sections.attention ?? []).map((a) => ({
                ...a,
                verdict: byId.get(a.narration_id)?.verdict ?? null,
                // How sure the narrator was (Ironclad 2), plus the source event
                // as the "why I said this" anchor.
                confidence: byId.get(a.narration_id)?.confidence ?? null,
                technical_detail: byId.get(a.narration_id)?.technicalDetail ?? null,
                event_id: byId.get(a.narration_id)?.eventId ?? null,
              })),
            },
          };
        }
      }

      // Own the miss out loud (Ironclad 2): any false-all-clear we haven't yet
      // surfaced becomes a correction on today's brief, then is marked shown.
      const openIncidents = await db
        .select()
        .from(trustIncidents)
        .where(and(eq(trustIncidents.orgId, orgId), eq(trustIncidents.acknowledged, false)));
      const corrections = openIncidents.map((i) => ({
        id: i.id,
        project_id: i.projectId,
        line: i.detail ?? "Earlier I said this was fine — it wasn't.",
      }));
      if (openIncidents.length > 0) {
        await db
          .update(trustIncidents)
          .set({ acknowledged: true })
          .where(inArray(trustIncidents.id, openIncidents.map((i) => i.id)));
      }

      res.json({ digest: enriched, post_digest_events: postDigestEvents, corrections });
    }),
  );

  return router;
}
