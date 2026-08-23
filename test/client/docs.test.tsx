import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Docs, Security, Changelog } from '../../src/client/pages/Docs.js';
import { Prose } from '../../src/client/components/Prose.js';

/**
 * THE PUBLIC PAGES.
 *
 * These are the surfaces a person reads while deciding whether to trust this,
 * so the failure mode that matters is not "it looks wrong" but "it says
 * something that isn't true, or says nothing at all because the markdown
 * import broke". The imports are build-time (`?raw`), so a missing file is a
 * build failure rather than a 404 — what these tests hold is the layer above
 * that: the renderer, and the claims that must not quietly soften.
 */
const render = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('the docs, security and changelog pages', () => {
  it('renders every page with its content and a real date', () => {
    for (const page of [<Docs key="d" />, <Security key="s" />, <Changelog key="c" />]) {
      const html = render(page);
      expect(html).toContain('Last updated:');
      // Not a build stamp: a page claiming to have been reviewed on every
      // deploy is the false freshness a docs site should not have.
      expect(html).not.toContain('Last updated: Invalid');
      expect(html.length).toBeGreaterThan(2000);
    }
  });

  it('keeps the security page honest about what does not exist yet', () => {
    // The spec's own rule: anything not yet true gets built or cut, never
    // softened. There is no account-deletion route in this codebase, and the
    // page has to keep saying so until there is one.
    const html = render(<Security />);
    expect(html).toMatch(/not a button yet/i);
    expect(html).toMatch(/no SOC 2|no security team/i);
    // And the claims that ARE true stay specific enough to be checkable.
    expect(html).toContain('AES-256-GCM');
    expect(html).toContain('SHA-256');
  });

  it("keeps the limits page about what it can't see, not what it can", () => {
    const html = render(<Docs />);
    expect(html).toBeTruthy();
    const limits = render(<Docs />);
    expect(limits).toContain('Selvedge');
  });

  describe('the renderer, which exists instead of a markdown dependency', () => {
    it('renders the shapes the pages actually use', () => {
      const html = renderToStaticMarkup(
        <Prose markdown={'# Title\n\nA paragraph with `code` and **bold**.\n\n- one\n- two\n\n```\nliteral *text*\n```\n'} />,
      );
      expect(html).toContain('<h1');
      expect(html).toContain('<code');
      expect(html).toContain('<strong');
      expect(html).toContain('<li>one</li>');
      // A fenced block is verbatim: a shell command with a star in it is a
      // shell command, not emphasis.
      expect(html).toContain('literal *text*');
    });

    it('gives every heading an id, so a link can point at one', () => {
      const html = renderToStaticMarkup(<Prose markdown={'## What it can’t read\n'} />);
      expect(html).toContain('id="what-it-can-t-read"');
    });

    it('keeps the source comments in the source', () => {
      // The security page carries a code reference after every claim, for
      // whoever changes that file next. They rendered as visible text on the
      // page until somebody looked at it — which no test here had caught,
      // because every one of them asked whether content was PRESENT.
      const html = renderToStaticMarkup(<Prose markdown={'Claim.\n\n<!-- src/server/x.ts -->\n\nNext.\n'} />);
      expect(html).not.toContain('src/server/x.ts');
      expect(html).toContain('Claim.');
      expect(html).toContain('Next.');
    });

    it('never renders raw HTML from a document', () => {
      // The reason this is ours rather than a library's: HTML passthrough on a
      // page rendered from repo files is not a feature, it is a way for a
      // stray script tag in a document to become a script tag.
      const html = renderToStaticMarkup(<Prose markdown={'<script>alert(1)</script>\n'} />);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
