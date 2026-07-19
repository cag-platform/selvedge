import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ContextPack } from '../../shared/types/pack.js';

const DOC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/worked-examples.md');

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const CONTAINS_PLACEHOLDER = /[<>]/;
const LINK_KEYS = ['live_url', 'repo_url', 'host_dashboard_url', 'store_listing_url'] as const;

/**
 * worked-examples.md is illustrative prose, not schema-conformant data —
 * it uses bare `<placeholder>` tokens for IDs/URLs still to be filled in,
 * and `null` for "not yet known" fields the strict schema only allows to
 * be *omitted* (context-pack.schema.json makes exactly one field nullable,
 * state.serving_now.healthy — "null = cannot determine, the narrator must
 * say so, not guess" — every other unknown is expressed by leaving the key
 * out). This is a genuine doc-vs-doc tension (flagged in the PR
 * description); the fix here is conservative and narrow: drop a links.*
 * value only when it isn't URI-shaped at all (an embedded placeholder
 * segment inside an otherwise real URL, e.g. ".../<cag-web-repo>", still
 * passes and is left alone), and drop explicit nulls on
 * serving_now.version_ref/deployed_at (never on `healthy`, which the
 * schema means to carry null).
 */
function sanitizeForSchema(pack: ContextPack): ContextPack {
  const sanitized: ContextPack = structuredClone(pack);

  const links = sanitized.identity.links;
  if (links) {
    for (const key of LINK_KEYS) {
      const value = links[key];
      if (value !== undefined && (!HAS_SCHEME.test(value) || CONTAINS_PLACEHOLDER.test(value))) {
        delete links[key];
      }
    }
  }

  const servingNow = sanitized.state?.serving_now;
  if (servingNow) {
    if (servingNow.version_ref === null) delete servingNow.version_ref;
    if (servingNow.deployed_at === null) delete servingNow.deployed_at;
  }

  return sanitized;
}

/** Extracts the eight context-pack JSON blocks embedded in docs/worked-examples.md. */
export function loadWorkedExamplePacks(): ContextPack[] {
  const text = readFileSync(DOC_PATH, 'utf-8');
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] as string);
  const packs = blocks.map((block) => JSON.parse(block) as ContextPack).filter((p) => p.pack_version === '1.0');
  return packs.map(sanitizeForSchema);
}
