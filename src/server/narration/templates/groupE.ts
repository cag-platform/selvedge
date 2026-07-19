import { projectName, technicalLine } from '../slots.js';
import type { TemplateFn } from '../types.js';

// E1 (connector auth failed) and E4 (unsorted tray accumulating) are
// org-level, not project-level — they never go through route()/narrate()
// against a pack. See narration/orgLevel.ts.

export const E2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: its repo looks out of date with what's actually live — narrating from the host side for now.`,
  technicalDetail: technicalLine(event),
});
