/**
 * WHAT THE TAB SAYS.
 *
 * A single-page app serves one `index.html`, so without this every route in
 * Selvedge shares one title — twelve tabs all reading the same thing, which is
 * the kind of detail nobody names and everybody notices.
 *
 * TWO THINGS ARE TRUE HERE AND THEY PULL IN OPPOSITE DIRECTIONS, so the work
 * is split accordingly.
 *
 * 1. A LINK CARD IS NOT A CLIENT-SIDE PROBLEM. Slack, X, and iMessage fetch
 *    the HTML and never run the JavaScript. A `<meta property="og:image">`
 *    written by React — by any means, in any version — is invisible to every
 *    one of them. So the card lives in `src/client/index.html`, statically,
 *    where a crawler will actually find it. That is also sufficient: the
 *    landing IS the root URL, and every other route is behind auth, where
 *    there is nothing a stranger could be shown anyway.
 *
 * 2. A TAB TITLE IS EXACTLY A CLIENT-SIDE PROBLEM. It changes as you navigate,
 *    which is a thing only the running app knows about. That is what this file
 *    does, and all it does.
 *
 * ONE PLACE DECIDES, WHICH IS WHY THERE IS NO HOOK HERE. This file used to
 * also export `usePageTitle` and a `PageHead` component, so every surface could
 * name itself. That is a rule five components have to remember and the sixth
 * one added later inherits whatever the last route set — so App.tsx maps the
 * path to the name instead, and a route that is not in that table falls back to
 * the product's own name rather than to a stale one. The hook and the component
 * outlived that decision by never being deleted; nothing had called either
 * since.
 *
 * NO DEPENDENCY, AND A CORRECTION WORTH RECORDING. The obvious move is to
 * render `<title>` inside the component and let React hoist it into `<head>`.
 * That is a REACT 19 feature; this codebase is on 18.3.1, where the same JSX
 * renders a `<title>` element into the body that sets no document title at
 * all — silently, and only in production. react-helmet-async exists for
 * exactly this gap, and is still not worth a dependency for eleven lines of
 * `document.title`.
 *
 * A PROJECT NAME NEVER REACHES A TITLE. A title is read by anyone looking at
 * the screen and copied into any link someone shares; "Loom · Selvedge" in a
 * shared tab strip leaks a customer's project to the room. Authed surfaces get
 * the surface's own name and nothing about its contents.
 */

/** What the tab says with nothing else set — and what it goes back to. */
export const DEFAULT_TITLE = 'Selvedge — All your AI. One conversation.';

/** "Inbox" → "Inbox · Selvedge", for as long as this surface is mounted. */
export function titleFor(name: string): string {
  return `${name} · Selvedge`;
}
