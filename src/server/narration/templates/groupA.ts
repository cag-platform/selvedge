import { projectName, technicalLine } from '../slots.js';
import type { TemplateFn } from '../types.js';

// A1 (commit pushed to non-default branch) is SILENT at every tier — no template needed.

// NO RELATIVE TIME IN A FRAGMENT. These sentences are written once, at ingest,
// and stored — then read forever. "today" was true when the only surface was a
// daily brief covering the last 24 hours; the brief is retired, and the same
// sentence now sits in a project's timeline directly beneath the date it
// actually happened. An entry stamped "Aug 14" that says "today" is the
// product being wrong out loud about the one thing it exists to get right.
//
// Every surface prints the real timestamp beside the fragment, so the word was
// redundant where it was true and false everywhere else.
export const A2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: new work landed on the main branch.`,
  technicalDetail: technicalLine(event),
});

export const A3: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: new work started on a branch.`,
  technicalDetail: technicalLine(event),
});

// VOICE-REVIEW: this is the LIB/LLM row (A4) collapsed to TEMPLATE — Phase 2's
// layman gist ("SZD's hardest piece moved forward: ...") needs the LLM path;
// this plain fallback just states that something substantial landed.
export const A4: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a substantial piece of work landed.`,
  technicalDetail: technicalLine(event),
});

export const A5: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a branch has been quiet for two weeks — still want it?`,
  technicalDetail: technicalLine(event),
});

export const A6: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} had been quiet — there's new activity.`,
  technicalDetail: technicalLine(event),
});
