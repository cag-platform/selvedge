import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Inbox } from '../../src/client/pages/Inbox.js';
import '../../src/client/index.css';
import { cardsFixture, inboxFixture, searchFixture, threadFixture, timelineFixture } from './fixture.js';

/**
 * The workbench, rendered against fixed data and nothing else — no server, no
 * session, no network. This is what the screenshot check looks at: the real
 * components, the real tokens, six projects and thirty threads.
 */
const ROUTES: Array<[RegExp, unknown]> = [
  [/\/api\/inbox$/, inboxFixture()],
  [/\/timeline/, timelineFixture()],
  [/\/search/, searchFixture],
  [/\/api\/threads\//, threadFixture()],
  [/\/api\/cards/, cardsFixture],
  [/\/api\/packs\//, { identity: { project_id: 'p0', name: 'Loom', owner_description: 'A made-to-measure curtain shop.' }, stakes: {}, topology: { sources: [] } }],
];

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const hit = ROUTES.find(([pattern]) => pattern.test(url));
  return new Response(JSON.stringify(hit ? hit[1] : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/inbox/p0t0']}>
    <Routes>
      <Route path="/inbox/project/:projectId" element={<Inbox />} />
      <Route path="/inbox/:threadId" element={<Inbox />} />
      <Route path="*" element={<Inbox />} />
    </Routes>
  </MemoryRouter>,
);
