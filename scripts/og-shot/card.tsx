import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SampleThread } from '../../src/client/pages/Landing.js';
import { SelvedgeLockup } from '../../src/client/components/Logo.js';
import '../../src/client/index.css';

/**
 * THE SHARE CARD, RENDERED FROM THE PRODUCT.
 *
 * A card drawn to look like the app is a picture that goes stale the first time
 * the app changes and nobody notices for six months. This one mounts the REAL
 * `SampleThread` from the landing page, on the real chalk paper, with the real
 * wordmark — so the only way for the card to become a lie is for the landing
 * page itself to be wrong.
 *
 * Three messages: the question and the two signed answers. That is the whole
 * argument, and it is the most a 1200×630 card can hold at a legible size.
 *
 * WHY `zoom` AND NOT A FONT SIZE. The type scale is absolute pixel tokens, so
 * setting a larger font here would scale the words and leave the edge seam, the
 * chip borders, and the paddings at fourteen-pixel proportions — the card would
 * be the real component with the wrong build. `zoom` scales the rendered box,
 * which keeps every proportion the design system chose. It is Chromium-only,
 * and this file only ever runs in Chromium.
 *
 * The card is read at perhaps 500px wide in a feed, so 1.7× is what puts the
 * body text at a size a person can actually read there.
 */
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <div
      id="card"
      className="flex flex-col justify-between overflow-hidden"
      style={{ width: 1200, height: 630, background: 'var(--paper)', padding: 48 }}
    >
      <div style={{ zoom: 1.7 }}>
        <SampleThread short caption={false} />
      </div>
      {/* A flex column stretches its children, and a stretched SVG centres its
          own contents — the wordmark belongs at the left edge. Inline styles,
          not utility classes: Tailwind scans src/client, not scripts/, so a
          class used only here is never generated and fails silently. */}
      <div style={{ alignSelf: 'flex-start' }}>
        <SelvedgeLockup tone="chalk" className="h-11 w-auto" />
      </div>
    </div>
  </MemoryRouter>,
);
