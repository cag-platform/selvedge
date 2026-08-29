import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MigrationPreview } from '../../src/client/components/MigrationPreview.js';

describe('native migration preview', () => {
  it('opens as an interactive workspace drawer with responsive device controls', () => {
    const html = renderToStaticMarkup(<MigrationPreview url="https://preview.example/workspace-preview/abc/?preview_token=secret" />);
    expect(html).toContain('Live migration workspace preview');
    expect(html).toContain('Desktop');
    expect(html).toContain('Tablet');
    expect(html).toContain('Mobile');
    expect(html).toContain('production untouched');
    expect(html).not.toContain('preview_token=secret</span>');
  });
});
