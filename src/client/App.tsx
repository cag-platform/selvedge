import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import { Nav } from './components/Nav.js';
import { Today } from './pages/Today.js';
import { Projects } from './pages/Projects.js';
import { Tray } from './pages/Tray.js';
import { PackEditor } from './pages/PackEditor.js';
import { Admin } from './pages/Admin.js';
import { Styleguide } from './pages/Styleguide.js';
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
  return (
    <>
      <SignedOut>
        <div className="flex min-h-screen items-center justify-center">
          <SignIn />
        </div>
      </SignedOut>
      <SignedIn>
        <AutoTimezone />
        <div className="min-h-screen">
          <Nav />
          <main className="mx-auto max-w-3xl px-4 py-8">
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:projectId/edit" element={<PackEditor />} />
              <Route path="/tray" element={<Tray />} />
              <Route path="/admin" element={<Admin />} />
            </Routes>
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
