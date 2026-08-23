import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Landing } from '../../src/client/pages/Landing.js';

/**
 * THE LANDING PAGE, RENDERED.
 *
 * The landing now demonstrates the project layer directly: shared context,
 * signed answers, imported history, and coding work in the same record.
 */
function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  );
}

describe('the landing page', () => {
  it('does not borrow the needs-you colour as decoration', () => {
    expect(render()).not.toContain('--thread');
  });

  it('makes existing project context visible before explaining it', () => {
    const html = render();
    expect(html).toContain('12 conversations in context');
    expect(html).toContain('both answers used the same 12 imported conversations');
    expect(html).toContain('3 conversations added to Loom');
  });

  it('says the one sentence the whole product is, and shows it being true', () => {
    const html = render();
    expect(html).toContain('Your AI should know what the others already know.');
    expect(html).toContain('@claude');
    expect(html).toContain('@gpt');
    expect(html).toContain('@codex');
    expect(html).toContain('CL');
    expect(html).toContain('GPT');
    expect(html).toContain('CX');
  });

  it('carries no vendor logo or brand colour, only text chips', () => {
    const html = render();
    // Naming a vendor in a sentence is fine and unavoidable — the page is
    // about running four of them. What is banned is IMAGERY and BRAND COLOUR:
    // the colour system means status, and a page carrying vendor colour would
    // teach a stranger to read colour as brand before they had seen it mean
    // anything else. So agent identity is text, here as everywhere.
    expect(html).not.toContain('<img');
    // Every colour on the page comes from the token set — a vendor's would
    // have to be written literally to get here. The Selvedge lockup is the
    // product's own mark and carries its own palette, so it is set aside
    // rather than exempted by name.
    const withoutLockup = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    expect(withoutLockup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // And identity in the sample thread is the real chip: two or three
    // characters of mono text, nothing else.
    for (const chip of ['>CL<', '>GPT<', '>CX<']) {
      expect(html).toContain(chip);
    }
  });

  it('keeps the words the house does not say', () => {
    const html = render().toLowerCase();
    for (const banned of ['observability', 'nobody does this', 'nobody else']) {
      expect(html).not.toContain(banned);
    }
  });
});
