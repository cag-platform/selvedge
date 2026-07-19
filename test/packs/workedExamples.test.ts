import { describe, it, expect } from 'vitest';
import { loadWorkedExamplePacks } from '../../src/server/packs/workedExamples.js';
import { validatePack } from '../../src/server/packs/validate.js';

describe('packs/workedExamples', () => {
  it('extracts all eight packs from docs/worked-examples.md, each valid against the schema', () => {
    const packs = loadWorkedExamplePacks();
    expect(packs).toHaveLength(8);

    const ids = packs.map((p) => p.identity.project_id).sort();
    expect(ids).toEqual(['cag-web-crm', 'loom', 'mirror', 'sb-master', 'sild', 'szd', 'toile', 'yoke'].sort());

    for (const pack of packs) {
      const result = validatePack(pack);
      if (!result.valid) {
        throw new Error(`${pack.identity.project_id} failed validation: ${result.errors.join(', ')}`);
      }
    }
  });
});
