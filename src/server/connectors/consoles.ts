import type { ContextPack } from '../../shared/types/pack.js';
import { parseRailwayTarget } from './railway/client.js';

/**
 * THE DOORS TO THE ACCOUNTS BEHIND A PROJECT.
 *
 * Everything a project runs on is somebody else's console — the Railway
 * service with its variables, the Neon database, the repo — and every one of
 * those consoles was reachable only by leaving Selvedge and finding it by
 * hand. The identifiers were already stored: go-live writes them into
 * `pack.topology.sources` when it provisions, and imports write the repo. This
 * module turns those rows into the URLs they name, and nothing else.
 *
 * COMPUTED ON THE SERVER, ON PURPOSE. One copy of each provider's URL format,
 * and both clients render the same strings — the phone cannot drift from the
 * web because neither builds a URL. When a provider moves its console (Railway
 * has already been railway.app and railway.com in its lifetime), the fix is
 * one line here, not a release of the iOS app.
 *
 * NO SECRETS TOUCH THIS. The links carry resource identifiers, never values;
 * whether the person can open the console is decided by the provider's own
 * session in their own browser. That is what makes "one click to your
 * secrets" safe to offer: Selvedge points at the door and the provider checks
 * the key.
 *
 * A MALFORMED ID YIELDS NO LINK, never a broken one. A link that 404s teaches
 * the owner the feature lies; a missing link says only that Selvedge doesn't
 * know that console, which is true.
 *
 * Vercel is deliberately absent from v1: its dashboard URLs need the team
 * slug (`vercel.com/{team}/{project}`), which is not derivable from the
 * stored ids without a network call. It joins by persisting its dashboard URL
 * at provision time, not by guessing here.
 */

export type ConsoleLink = {
  /** The provider's name as a person says it — "Railway", not a connector id. */
  provider: string;
  /** What is behind the door, in the owner's words. */
  label: string;
  url: string;
};

const enc = encodeURIComponent;

/** A resource id with whitespace or URL-breaking characters is not an id. */
function clean(id: string): boolean {
  return id.trim() !== '' && !/[\s?#]/.test(id);
}

function linkFor(connector: string, resourceId: string): ConsoleLink | null {
  switch (connector) {
    case 'github': {
      // owner/name, exactly — anything else is not a repo we can point at.
      const parts = resourceId.split('/');
      if (parts.length !== 2 || !parts.every(clean)) return null;
      return { provider: 'GitHub', label: resourceId, url: `https://github.com/${parts.map(enc).join('/')}` };
    }
    case 'railway': {
      // projectId/environmentId/serviceId — the same triplet go-live stores.
      // Straight to the variables tab, because "get to my secrets" is the
      // whole reason this link exists.
      const target = parseRailwayTarget(resourceId);
      if (!target || ![target.projectId, target.environmentId, target.serviceId].every(clean)) return null;
      return {
        provider: 'Railway',
        label: 'variables & deploys',
        url: `https://railway.com/project/${enc(target.projectId)}/service/${enc(target.serviceId)}/variables?environmentId=${enc(target.environmentId)}`,
      };
    }
    case 'neon': {
      if (!clean(resourceId) || resourceId.includes('/')) return null;
      return { provider: 'Neon', label: 'database console', url: `https://console.neon.tech/app/projects/${enc(resourceId)}` };
    }
    case 'supabase': {
      if (!clean(resourceId) || resourceId.includes('/')) return null;
      return { provider: 'Supabase', label: 'database console', url: `https://supabase.com/dashboard/project/${enc(resourceId)}` };
    }
    default:
      return null;
  }
}

/**
 * Where a person reaches for these, the runtime comes before the code:
 * "I need to change a variable" and "is the database okay?" are the questions
 * that send somebody console-hunting; the repo is the one door they already
 * know. Ties keep the pack's own source order.
 */
const PRECEDENCE = ['railway', 'neon', 'supabase', 'github'];

export function consoleLinks(pack: Pick<ContextPack, 'topology'>): ConsoleLink[] {
  const seen = new Set<string>();
  const found: Array<{ link: ConsoleLink; i: number; connector: string }> = [];
  (pack.topology.sources ?? []).forEach((source, i) => {
    const link = linkFor(source.connector, source.resource_id);
    if (!link) return;
    // A source listed twice (two roles on one repo) is one door, not two.
    if (seen.has(link.url)) return;
    seen.add(link.url);
    found.push({ link, i, connector: source.connector });
  });
  return found
    .sort((a, b) => PRECEDENCE.indexOf(a.connector) - PRECEDENCE.indexOf(b.connector) || a.i - b.i)
    .map(({ link }) => link);
}
