import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpinionComparison } from '../../src/client/components/OpinionComparison.js';

describe('the two-agent opinion comparison', () => {
  it('labels the relationship and each opinion without relying on the two-column layout', () => {
    const html = renderToStaticMarkup(
      <OpinionComparison
        promptId="prompt-1"
        answers={[
          { agent: 'claude-code', body: <p>Keep the divider.</p> },
          { agent: 'codex', body: <p>Use spacing instead.</p> },
        ]}
      />,
    );

    expect(html).toContain('id="opinion-comparison-prompt-1"');
    expect(html).toContain('aria-labelledby="opinion-comparison-prompt-1"');
    expect(html).toContain('Compare opinions');
    expect(html).toContain('Claude Code and Codex answered the same question.');
    expect(html).toContain('aria-label="Claude Code opinion"');
    expect(html).toContain('aria-label="Codex opinion"');
    expect(html).toContain('Keep the divider.');
    expect(html).toContain('Use spacing instead.');
  });

  it('fits columns to the resizable work pane rather than the viewport', () => {
    const html = renderToStaticMarkup(
      <OpinionComparison
        promptId="prompt-2"
        answers={[
          { agent: 'claude-code', body: 'First' },
          { agent: 'codex', body: 'Second' },
        ]}
      />,
    );

    expect(html).toContain('grid-template-columns:repeat(auto-fit, minmax(min(100%, 22rem), 1fr))');
    expect(html).not.toContain('lg:grid-cols-2');
  });
});
