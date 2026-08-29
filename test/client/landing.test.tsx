import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Landing } from '../../src/client/pages/Landing.js';
import { planBullets, priceLine } from '../../src/shared/plans.js';

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
    expect(html).toContain('PROJECT MAP');
    expect(html).toContain('Postgres');
    expect(html).toContain('Auth + storage');
    expect(html).toContain('stays live throughout');
  });

  it('walks a visitor through the safe migration cycle', () => {
    const html = render();
    for (const stage of ['Ask', 'Discover', 'Migrate', 'Preview', 'Verify', 'Approve']) {
      expect(html).toContain(`>${stage}<`);
    }
    expect(html).toContain('Guided Selvedge migration demonstration');
    expect(html).toContain('production app, users, data, and domain remain untouched');
    expect(html).toContain('Selvedge does the migration');
    expect(html).toContain('you approve cutover');
    expect(html).toContain('you supervise, Selvedge does the work');
  });

  it('says the one sentence the whole product is, and shows it being true', () => {
    const html = render();
    expect(html).toContain('Can’t stop vibe coding but don’t want to pay for Replit anymore? Come home.');
    expect(html).toContain('Selvedge’s agents migrate the project');
    expect(html).toContain('infrastructure in accounts you control');
    expect(html).toContain('Agent-neutral by design');
    expect(html).toContain('You supervise. Selvedge does the work.');
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

/**
 * THE PRICING SECTION.
 *
 * The bug this section could have is a page that says "60 build minutes" while
 * the server allows 30. So none of these tests assert a price — they assert
 * that what the page renders IS what the plan table holds, which is what the
 * entitlements module enforces. A price change should not have to be typed
 * twice, here included.
 */
describe('the pricing section', () => {
  const html = () => render();

  it('is reachable from the nav by the anchor the brief names', () => {
    expect(html()).toContain('id="pricing"');
    expect(html()).toContain('href="#pricing"');
  });

  it('renders every number from the plan table rather than from a copywriter', () => {
    const page = html();
    for (const line of [...planBullets('free'), ...planBullets('pro')]) {
      expect(page).toContain(line);
    }
    expect(page).toContain(priceLine('pro'));
    expect(page).toContain(priceLine('free'));
  });

  it('says whose the model costs are, and never implies they are included', () => {
    const page = html();
    expect(page).toContain('your own AI keys');
    expect(page).toContain('spend ceilings');
    // "Unlimited AI" is the claim this product must never make.
    expect(page.toLowerCase()).not.toContain('unlimited ai');
  });

  /**
   * The founding-member line is a promise kept in a database column. Dressing
   * it as scarcity would make the one true thing on the page look like the
   * fake ones everywhere else.
   */
  it('makes the founding-member promise a price, not a countdown', () => {
    const page = html().toLowerCase();
    expect(page).toContain('founding member');
    for (const hype of ['% off', 'limited time', 'hurry', 'act now', 'expires']) {
      expect(page).not.toContain(hype);
    }
  });

  it('answers the three questions somebody has before paying, in the page itself', () => {
    const page = html();
    // <details>, so the answers are in the markup whether or not anyone clicks
    // — readable without JavaScript and visible to a crawler.
    expect(page).toContain('What happens to my data on Free?');
    expect(page).toContain('What are build minutes?');
    expect(page).toContain('Will the price go up?');
    expect(page).toMatch(/[Nn]othing is deleted/);
  });

  it('keeps the free tier honest about being free', () => {
    expect(html()).toContain('No card. No trial timer.');
  });
});
