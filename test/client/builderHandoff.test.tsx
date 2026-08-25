import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BuilderHandoff } from '../../src/client/components/BuilderHandoff.js';

const meta = {
  switch: {
    from: 'claude-code',
    to: 'codex',
    tokens: 418,
    cost_usd: 0.001,
    payload: null,
    pending: false,
  },
};

describe('a builder handoff in the thread', () => {
  it('makes the two builders and carried project context unmistakable', () => {
    const html = renderToStaticMarkup(<BuilderHandoff content="old receipt" meta={meta} detail="full" />);

    expect(html).toContain('CLAUDE CODE');
    expect(html).toContain('CODEX');
    expect(html).toContain('→');
    expect(html).toContain('Project context carried over');
    expect(html).toContain('aria-label="Builder changed from Claude Code to Codex. Project context carried over."');
    expect(html).toContain('418 tokens');
    expect(html).toContain('about $0.001');
  });

  it('keeps token and cost detail out of Simple mode without hiding the handoff', () => {
    const html = renderToStaticMarkup(<BuilderHandoff content="old receipt" meta={meta} detail="simple" />);

    expect(html).toContain('CLAUDE CODE');
    expect(html).toContain('CODEX');
    expect(html).toContain('Project context carried over');
    expect(html).not.toContain('418 tokens');
    expect(html).not.toContain('$0.001');
  });

  it('does not relabel an older unstructured system note as a builder handoff', () => {
    const html = renderToStaticMarkup(<BuilderHandoff content="Context from #pricing carried into this turn." meta={null} detail="simple" />);

    expect(html).toContain('Context from #pricing carried into this turn.');
    expect(html).not.toContain('Project context carried over');
  });
});
