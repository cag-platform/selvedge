import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/client/components/Nav.tsx', 'utf8');

describe('the secondary navigation menu', () => {
  it('puts the filtered header above the workbench stacking contexts', () => {
    expect(source).toContain('className="relative z-50 border-b border-hairline"');
  });

  it('dismisses on outside interaction, Escape, and completed choices', () => {
    expect(source).toContain("document.addEventListener('pointerdown', dismiss)");
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('onClick={closeSecondaryMenu}');
    expect(source).toContain('onThemeChange(option);');
    expect(source).toContain('closeSecondaryMenu();');
  });
});
