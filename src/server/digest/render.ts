import type { NarrationWithPack } from './order.js';

export type OpenThread = { project_id: string | null; summary: string; narration_id: string };

export type DigestSections = {
  headline: string;
  attention: NarrationWithPack[];
  moved: NarrationWithPack[];
  standing: string[];
  quiet: string;
  today: string | null;
  closedThreads: string[];
  storm: boolean;
  attentionTotal: number;
};

const ATTENTION_STORM_THRESHOLD = 3;
const MOVED_DISPLAY_CAP = 5;

function projectLabel(item: NarrationWithPack): string {
  return item.pack ? item.pack.identity.name : 'Selvedge';
}

function headlineFor(attention: NarrationWithPack[], moved: NarrationWithPack[], standing: string[], storm: boolean): string {
  const isQuietDay = attention.length === 0 && moved.length === 0 && standing.length === 0;
  if (isQuietDay) return 'A quiet night — nothing needs you.';
  if (storm) return `Rough night — ${attention.length} things need attention.`;
  if (attention.length === 0) return 'Everything users touch is healthy this morning.';
  return `${attention.length} thing${attention.length === 1 ? '' : 's'} worth a look this morning.`;
}

function closeThreads(previousOpenThreads: OpenThread[], attention: NarrationWithPack[]): string[] {
  const stillOpenProjectIds = new Set(attention.map((a) => a.projectId));
  return previousOpenThreads
    .filter((t) => t.project_id && !stillOpenProjectIds.has(t.project_id))
    .map((t) => `The issue from yesterday (${t.summary}) is resolved.`);
}

export function buildSections(
  allAttention: NarrationWithPack[],
  moved: NarrationWithPack[],
  standing: string[],
  quiet: string,
  previousOpenThreads: OpenThread[],
): DigestSections {
  const storm = allAttention.length > ATTENTION_STORM_THRESHOLD;
  // Storm mode triages rather than enumerating (digest-composer §6) — Phase
  // 1 has no LLM to "find the common cause", so it keeps the top 3 by the
  // same stakes ordering and names the rest by count rather than listing
  // all of them, which is the honest mechanical analogue.
  const attention = storm ? allAttention.slice(0, ATTENTION_STORM_THRESHOLD) : allAttention;

  const closedThreads = closeThreads(previousOpenThreads, allAttention);
  const today =
    allAttention.length === 1 && allAttention[0]
      ? `If you only touch one thing today: ${projectLabel(allAttention[0])}'s open item.`
      : null;

  return {
    headline: headlineFor(allAttention, moved, standing, storm),
    attention,
    moved: moved.slice(0, MOVED_DISPLAY_CAP),
    standing: standing.slice(0, 2), // digest-composer §2 hard cap: 2 standing items surfaced per day
    quiet,
    today,
    closedThreads,
    storm,
    attentionTotal: allAttention.length,
  };
}

/** Renders the skeleton mechanically into the note the Today page shows. Phase 1: stiff, deterministic, no LLM — proves the pipeline. */
export function renderDigestText(sections: DigestSections): string {
  const paragraphs: string[] = [sections.headline];

  for (const line of sections.closedThreads) paragraphs.push(line);

  for (const item of sections.attention) {
    paragraphs.push(`${projectLabel(item)}: ${item.fragment}`);
  }
  if (sections.storm) {
    const remaining = sections.attentionTotal - sections.attention.length;
    paragraphs.push(`(${remaining} more item${remaining === 1 ? '' : 's'} — see the expanded list on the Today page.)`);
  }

  if (sections.moved.length > 0) {
    paragraphs.push('What moved:');
    for (const item of sections.moved) paragraphs.push(`${projectLabel(item)}: ${item.fragment}`);
  }

  for (const line of sections.standing) paragraphs.push(line);

  if (sections.quiet) paragraphs.push(sections.quiet);

  if (sections.today) paragraphs.push(sections.today);

  return paragraphs.filter(Boolean).join('\n\n');
}
