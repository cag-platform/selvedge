import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TechnicalDetailChoices } from '../../src/client/pages/Preferences.js';

describe('technical detail preferences', () => {
  it('shows both modes, their effect, and the selected account default', () => {
    const html = renderToStaticMarkup(
      <TechnicalDetailChoices value="full" disabled={false} onChoose={() => undefined} />,
    );
    expect(html).toContain('Account technical detail');
    expect(html).toContain('Full');
    expect(html).toContain('Simple');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Exact commands, paths, and logs are one step deeper.');
    expect(html).toContain('Nothing technical is deleted or rewritten.');
  });
});
