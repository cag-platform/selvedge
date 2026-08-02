import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import { Nav } from './components/Nav.js';
import { Today } from './pages/Today.js';
import { Work } from './pages/Work.js';
import { TrackRecord } from './pages/TrackRecord.js';
import { Workshop } from './pages/Workshop.js';
import { Sketches, SketchThread } from './pages/Sketch.js';
import { Connections } from './pages/Connections.js';
import { Projects } from './pages/Projects.js';
import { Tray } from './pages/Tray.js';
import { PackEditor } from './pages/PackEditor.js';
import { Admin } from './pages/Admin.js';
import { Styleguide } from './pages/Styleguide.js';
import { SelvedgeLockup } from './components/Logo.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { api } from './lib/api.js';

/**
 * First sign-in from any browser teaches the org its timezone, so the
 * daily brief lands at the owner's real 7:00am without a settings visit.
 * Auto-detect never overrides an explicit choice (server enforces it too).
 */
function AutoTimezone() {
  useEffect(() => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTz) return;
    api
      .get<{ timezone: string; timezone_source: string }>('/api/org')
      .then((org) => {
        if (org.timezone_source === 'default' && org.timezone !== browserTz) {
          return api.patch('/api/org/timezone', { timezone: browserTz, source: 'auto' }).then(() => undefined);
        }
      })
      .catch(() => undefined);
  }, []);
  return null;
}

function AuthedApp() {
  // The workshop's two-pane layout (conversation + live preview) needs room;
  // every other page keeps the calm single-column measure.
  const wide = useLocation().pathname.endsWith('/workshop');
  return (
    <>
      <SignedOut>
        <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
          <div className="flex flex-col items-center gap-3 text-center">
            <SelvedgeLockup tone="chalk" className="h-11 w-auto" />
            <p className="max-w-sm text-body text-ink-dim">
              A calm, plain-English watch over the software you ship. One morning brief; the important things, first.
            </p>
          </div>
          <SignIn />
        </div>
      </SignedOut>
      <SignedIn>
        <AutoTimezone />
        <div className="min-h-screen">
          <Nav />
          <main className={`mx-auto ${wide ? 'max-w-6xl' : 'max-w-3xl'} px-4 py-8`}>
            <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/work" element={<Work />} />
              <Route path="/record" element={<TrackRecord />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:projectId/edit" element={<PackEditor />} />
              <Route path="/projects/:projectId/workshop" element={<Workshop />} />
              <Route path="/sketch" element={<Sketches />} />
              <Route path="/sketch/:sketchId" element={<SketchThread />} />
              <Route path="/tray" element={<Tray />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/admin" element={<Admin />} />
            </Routes>
            </ErrorBoundary>
          </main>
        </div>
      </SignedIn>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Tokens only, no data — public by design so the design contract is
          viewable (and screenshot-testable) without a session. */}
      <Route
        path="/styleguide"
        element={
          <main className="mx-auto max-w-3xl px-4 py-8">
            <Styleguide />
          </main>
        }
      />
      <Route path="*" element={<AuthedApp />} />
    </Routes>
  );
}
