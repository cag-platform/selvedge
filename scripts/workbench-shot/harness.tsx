import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Inbox } from '../../src/client/pages/Inbox.js';
import { Home } from '../../src/client/pages/Home.js';
import '../../src/client/index.css';
import { cardsFixture, decisionFixture, inboxFixture, searchFixture, threadFixture, timelineFixture } from './fixture.js';

/** ?decision=stale|current|none — the shot's most important state is the stale one. */
const decision = new URLSearchParams(window.location.search).get('decision') ?? 'none';
/** ?fail=create — make thread creation refuse, to prove a refusal is visible. */
const failCreate = new URLSearchParams(window.location.search).get('fail') === 'create';

/**
 * The workbench, rendered against fixed data and nothing else — no server, no
 * session, no network. This is what the screenshot check looks at: the real
 * components, the real tokens, six projects and thirty threads.
 */
const ROUTES: Array<[RegExp, unknown]> = [
  [/\/api\/inbox$/, inboxFixture()],
  // Before the threads route, which would otherwise swallow it.
  [/\/decision$/, decision === 'none' ? { brief: null } : decisionFixture(decision === 'stale')],
  [/\/timeline/, timelineFixture()],
  [/\/search/, searchFixture],
  [/\/api\/threads\//, threadFixture()],
  [/\/api\/cards/, cardsFixture],
  [/\/api\/packs\//, { identity: { project_id: 'p0', name: 'Loom', owner_description: 'A made-to-measure curtain shop.' }, stakes: {}, topology: { sources: [] } }],
];

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (failCreate && /\/threads$/.test(url)) {
    return new Response(JSON.stringify({ error: "The workshop isn't switched on here yet." }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }
  const hit = ROUTES.find(([pattern]) => pattern.test(url));
  return new Response(JSON.stringify(hit ? hit[1] : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

/** ?surface=home — photograph the front door instead of the workbench. */
const surface = new URLSearchParams(window.location.search).get('surface');

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[surface === 'home' ? '/' : '/inbox/p0t0']}>
    <Routes>
      {/* The app shell gives every non-workbench page this measure; the
          harness reproduces it so the shot is the page as shipped. */}
      <Route path="/" element={<main className="mx-auto max-w-3xl px-4 py-8"><Home /></main>} />
      <Route path="/inbox/project/:projectId" element={<Inbox />} />
      <Route path="/inbox/:threadId" element={<Inbox />} />
      <Route path="*" element={<Inbox />} />
    </Routes>
  </MemoryRouter>,
);
