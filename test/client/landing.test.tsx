import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Landing } from '../../src/client/pages/Landing.js';

/**
 * THE LANDING PAGE, RENDERED.
 *
 * One assertion here earns its place above all the others: the rust ration.
 *
 * `--thread` is the colour that means "this needs you" and nothing else, in
 * the app and on this page. A marketing page needs nothing from you but a
 * click, so it has exactly one honest use for that colour — the "needs you"
 * edge in the four-state specimen strip, shown so a stranger learns the
 * vocabulary before they ever sign in. Every other use would be decoration
 * borrowed from a signal, and the cost is not on this page: it is the day
 * something in the product turns rust and the owner has already been taught
 * the colour is just how Selvedge draws things.
 *
 * A rule stated in a comment is a rule until somebody adds a highlight. So it
 * is counted.
 */
function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  );
}

describe('the landing page', () => {
  it('spends rust exactly once, on the one thing that means "needs you"', () => {
    // Counted by ELEMENT, not by occurrence: the needs edge names `--thread`
    // twice in one style attribute (the seam and its glow), and counting raw
    // occurrences would make the rule fail on a correct page and pass on a
    // page with two half-coloured ones.
    const wearingRust = (render().match(/style="[^"]*--thread[^"]*"/g) ?? []).length;
    expect(wearingRust).toBe(1);
  });

  it('shows the whole edge vocabulary, so "can\'t tell" is learned as its own state', () => {
    const html = render();
    // The four specimens. The dashed one matters most: a stranger has to see
    // that "I can't tell" is a different shape and not a paler version of fine.
    for (const token of ['--healthy', '--brass', '--thread', '--ink-faint']) {
      expect(html).toContain(token);
    }
    expect(html).toContain('repeating-linear-gradient');
  });

  it('says the one sentence the whole product is, and shows it being true', () => {
    const html = render();
    expect(html).toContain('All your AI.');
    // Both sigils, in the sample conversation rather than in a feature list —
    // the page's argument is that you read the thread and get it.
    expect(html).toContain('@claude');
    expect(html).toContain('#stripe-timeouts');
    // Two models, each answering as itself. Signed answers are the claim.
    expect(html).toContain('CL');
    expect(html).toContain('GPT');
    expect(html).toContain('CC');
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
    for (const chip of ['>CL<', '>GPT<', '>CC<']) {
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
