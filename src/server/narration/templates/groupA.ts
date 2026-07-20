import { projectName, technicalLine } from '../slots.js';
import type { TemplateFn } from '../types.js';

// A1 (commit pushed to non-default branch) is SILENT at every tier — no template needed.

export const A2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: new work landed on the main branch today.`,
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
  fragment: `${projectName(pack)}: a substantial piece of work landed today.`,
  technicalDetail: technicalLine(event),
});

export const A5: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a branch has been quiet for two weeks — still want it?`,
  technicalDetail: technicalLine(event),
});

export const A6: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} had been quiet — there's new activity today.`,
  technicalDetail: technicalLine(event),
});
