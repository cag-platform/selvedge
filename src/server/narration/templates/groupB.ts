import { downtimeTranslation, projectName, technicalLine } from '../slots.js';
import type { TemplateFn } from '../types.js';

// B1 (build started) is SILENT at every tier — no template needed.

export const B2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: your update went live cleanly.`,
  technicalDetail: technicalLine(event),
});

// VOICE-REVIEW
export const B3: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: the current build is taking longer than usual.`,
  technicalDetail: technicalLine(event),
});

// B4's verdict is knowable without a host connector or an LLM: a build that
// never reached deploy cannot have changed what's running in production.
export const B4: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a build failed before it could deploy. Nothing users see has changed.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_not_affected',
});

export const B5: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: the flaky check failed again — it usually passes on retry.`,
  technicalDetail: technicalLine(event),
});

// The row's own definition states the previous version is still serving —
// the verdict follows directly, no guessing required.
export const B6: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: your update couldn't go live. The previous version is still running, so ${downtimeTranslation(
    pack,
  )} is not happening — nothing users see has changed.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_not_affected',
});

// VOICE-REVIEW: same logic, the row's definition states nothing is serving.
export const B7: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: your update failed and nothing is currently live — ${downtimeTranslation(pack)}.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_affected',
});
