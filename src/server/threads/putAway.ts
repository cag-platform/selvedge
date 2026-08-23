import type { Db } from '../db/client.js';
import { getPack, setPackMuted } from '../packs/store.js';
import { getSubject, setSubjectArchived } from './subjects.js';

/**
 * PUT A PLACE AWAY — one call, whichever kind of place it is.
 *
 * The rail is one list on purpose: a subject is a project without a repo, and
 * the owner should never have to know which they are looking at before they
 * can act on it. That promise has to hold at the seam too. Two endpoints —
 * `PATCH /api/packs/:id/mute` for one kind and `PATCH /api/subjects/:id` for
 * the other — would put the distinction back in the client's hands, in the one
 * component whose entire job is that the distinction doesn't matter.
 *
 * So the resolution happens here: a project first, then a subject, then a
 * plain "no such place". Both lookups are org-scoped, so the ambiguity is
 * bounded to one workspace's own names, and neither can reach another org's.
 */

export type PutAwayResult = { ok: true; kind: 'project' | 'subject' } | { ok: false };

export async function setPlacePutAway(db: Db, orgId: string, id: string, away: boolean): Promise<PutAwayResult> {
  if (id.trim() === '') return { ok: false };

  // A project id is a slug the owner picked; a subject id is a ULID we made.
  // They cannot collide in practice, but the order is stated rather than
  // assumed, so a workspace that manages it gets the same answer every time.
  if (await getPack(db, orgId, id)) {
    return (await setPackMuted(db, orgId, id, away)) ? { ok: true, kind: 'project' } : { ok: false };
  }
  if (await getSubject(db, orgId, id)) {
    return (await setSubjectArchived(db, orgId, id, away)) ? { ok: true, kind: 'subject' } : { ok: false };
  }
  return { ok: false };
}
