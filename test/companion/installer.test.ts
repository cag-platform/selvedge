import { describe, expect, it } from 'vitest';
import { companionInstaller } from '../../src/server/companion/installer.js';

describe('companion installer', () => {
  it('installs the Selvedge-owned bundle without embedding a secret', () => {
    const script = companionInstaller('https://tryselvedge.com/');
    expect(script).toContain('https://tryselvedge.com/selvedge-companion.mjs');
    expect(script).toContain('$HOME/.local/bin');
    expect(script).toContain('process.versions.node');
    expect(script).not.toContain('slv_');
  });
});
