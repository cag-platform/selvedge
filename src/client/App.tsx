import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { SignedIn, SignedOut, SignIn, SignUp } from '@clerk/clerk-react';
import { Nav } from './components/Nav.js';
import { TrackRecord } from './pages/TrackRecord.js';
import { Inbox } from './pages/Inbox.js';
import { WorkshopRedirect } from './pages/WorkshopRedirect.js';
import { Connections } from './pages/Connections.js';
import { Projects } from './pages/Projects.js';
import { PackEditor } from './pages/PackEditor.js';
import { Admin } from './pages/Admin.js';
import { Styleguide } from './pages/Styleguide.js';
import { Landing } from './pages/Landing.js';
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
  // The Inbox is the workbench: three panes, full bleed, its own scrolling.
  // Every other page keeps the calm single-column measure it always had.
  const workbench = useLocation().pathname.startsWith('/inbox');
  return (
    <>
      <SignedOut>
        {/* Signed out, every path is the landing page except /sign-in, which
            keeps the original centered Clerk card. A signed-in visit to these
            same paths falls through to the app below — so "/" is the landing
            for a stranger and the workbench for an owner. */}
        <Routes>
          <Route
            path="/sign-in"
            element={
              <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
                <div className="flex flex-col items-center gap-3 text-center">
                  <SelvedgeLockup tone="chalk" className="h-11 w-auto" />
                  <p className="max-w-sm text-body text-ink-dim">
                    A calm, plain-English watch over the software you ship. One morning brief; the important things, first.
                  </p>
                </div>
                <SignIn signUpUrl="/sign-up" />
              </div>
            }
          />
          <Route
            path="/sign-up"
            element={
              <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
                <div className="flex flex-col items-center gap-3 text-center">
                  <SelvedgeLockup tone="chalk" className="h-11 w-auto" />
                  <p className="max-w-sm text-body text-ink-dim">
                    Make an account, then bring an app you already own — the walkthrough takes it from there.
                  </p>
                </div>
                <SignUp signInUrl="/sign-in" />
              </div>
            }
          />
          <Route path="*" element={<Landing />} />
        </Routes>
      </SignedOut>
      <SignedIn>
        <AutoTimezone />
        <div className="min-h-screen">
          <Nav />
          <main className={workbench ? '' : 'mx-auto max-w-3xl px-4 py-8'}>
            <ErrorBoundary>
            <Routes>
              {/* The workbench is the app. The daily brief was a page you had
                  to go and read before you could get to the work; what it
                  actually knew now sits with the projects it is about. */}
              <Route path="/" element={<Navigate to="/inbox" replace />} />
              <Route path="/today" element={<Navigate to="/projects" replace />} />
              {/* The moment sign-in/up completes, these paths are the app's. */}
              <Route path="/sign-in" element={<Navigate to="/" replace />} />
              <Route path="/sign-up" element={<Navigate to="/" replace />} />
              <Route path="/inbox" element={<Inbox />} />
              {/* Static segment first: a project's history is not a thread id. */}
              <Route path="/inbox/project/:projectId" element={<Inbox />} />
              <Route path="/inbox/:threadId" element={<Inbox />} />
              {/* The Work surface is gone — every part of it had a better home.
                  A card that needs you is in the thread it came from, work in
                  motion is one line in that thread's Now panel, and what
                  finished is on the Record and the project's own history. A
                  bookmark lands on the front door rather than on nothing. */}
              <Route path="/work" element={<Navigate to="/" replace />} />
              <Route path="/record" element={<TrackRecord />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:projectId/edit" element={<PackEditor />} />
              {/* The workshop is a thread now — old links land in the conversation they meant. */}
              <Route path="/projects/:projectId/workshop" element={<WorkshopRedirect />} />
              {/* Unsorted lives in Admin now — keep the address working. */}
              <Route path="/tray" element={<Navigate to="/admin" replace />} />
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
