import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ClerkLoaded, SignedIn, SignedOut, SignIn, SignUp } from '@clerk/clerk-react';
import { Nav } from './components/Nav.js';
import { Landing } from './pages/Landing.js';

/**
 * WHAT A STRANGER DOWNLOADS.
 *
 * Everything below is behind a session, and a first visitor has none — so
 * shipping the workbench, the pack editor, and the styleguide inside the
 * landing page's bundle is asking somebody to download an app they cannot open
 * in order to read a page about it. The landing is the one route a stranger
 * ever sees, so it is the one route that stays in the main chunk.
 *
 * The fallback is deliberately nothing rather than a spinner: these chunks
 * arrive in milliseconds on a warm connection, and a flash of "loading" between
 * two routes is the same jank the 150ms skeleton floor exists to avoid. The
 * pane's own skeleton takes over once the component is running.
 */
const Inbox = lazy(() => import('./pages/Inbox.js').then((m) => ({ default: m.Inbox })));
const Now = lazy(() => import('./pages/Now.js').then((m) => ({ default: m.Now })));
const Continue = lazy(() => import('./pages/Continue.js').then((m) => ({ default: m.Continue })));
const Projects = lazy(() => import('./pages/Projects.js').then((m) => ({ default: m.Projects })));
const Migrate = lazy(() => import('./pages/Migrate.js').then((m) => ({ default: m.Migrate })));
const Health = lazy(() => import('./pages/Health.js').then((m) => ({ default: m.Health })));
const ProjectMemory = lazy(() => import('./pages/ProjectMemory.js').then((m) => ({ default: m.ProjectMemory })));
const PackEditor = lazy(() => import('./pages/PackEditor.js').then((m) => ({ default: m.PackEditor })));
const Admin = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Admin })));
const OpsDistribution = lazy(() => import('./pages/OpsDistribution.js').then((m) => ({ default: m.OpsDistribution })));
const WorkshopRedirect = lazy(() => import('./pages/WorkshopRedirect.js').then((m) => ({ default: m.WorkshopRedirect })));
const Styleguide = lazy(() => import('./pages/Styleguide.js').then((m) => ({ default: m.Styleguide })));
// Public, and split for the same reason the app is: a stranger reading the
// landing should not download the docs, and a stranger reading the docs should
// not download the workbench.
const Docs = lazy(() => import('./pages/Docs.js').then((m) => ({ default: m.Docs })));
const Security = lazy(() => import('./pages/Docs.js').then((m) => ({ default: m.Security })));
const Changelog = lazy(() => import('./pages/Docs.js').then((m) => ({ default: m.Changelog })));
const DemoLoginTransfer = lazy(() =>
  import('./pages/DemoLoginTransfer.js').then((m) => ({ default: m.DemoLoginTransfer })),
);
const DemoAppPreview = lazy(() => import('./pages/DemoAppPreview.js').then((m) => ({ default: m.DemoAppPreview })));
import { SelvedgeLockup } from './components/Logo.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { api } from './lib/api.js';
import { DEFAULT_TITLE, titleFor } from './components/Head.js';

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
  const pathname = useLocation().pathname;
  const workbench = pathname.startsWith('/inbox') || pathname === '/work';
  const dashboard = pathname === '/';
  const health = pathname === '/health';
  const memory = /^\/projects\/[^/]+$/.test(pathname);
  const [theme, setTheme] = useState<'light' | 'night' | 'system'>(() => {
    if (typeof window === 'undefined') return 'system';
    const saved = window.localStorage.getItem('selvedge.theme');
    return saved === 'light' || saved === 'night' || saved === 'system' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolvedTheme = theme === 'system' ? (systemDark ? 'night' : 'light') : theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { window.localStorage.setItem('selvedge.theme', theme); }, [theme]);
  useRouteTitle(pathname);
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
                    Every project&rsquo;s conversations, agents, and record, in one window.
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
                    Bring a repo, a ChatGPT export, or just a question. The walkthrough takes it from there.
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
        <div className="product-shell min-h-screen" data-theme={resolvedTheme} style={{ colorScheme: resolvedTheme === 'night' ? 'dark' : 'light' }}>
          <Nav theme={theme} resolvedTheme={resolvedTheme} onThemeChange={setTheme} />
          <main className={workbench || dashboard || health || memory ? '' : 'mx-auto max-w-3xl px-4 py-8'}>
            <ErrorBoundary>
            <Suspense fallback={null}>
            <Routes>
              {/* Now is the scheduler and launchpad; Threads is the workbench. */}
              <Route path="/" element={<Now />} />
              <Route path="/continue" element={<Continue />} />
              <Route path="/continue/:continuationId/claims/:claimId" element={<Continue />} />
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
              <Route path="/work" element={<Inbox />} />
              <Route path="/health" element={<Health />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/migrate" element={<Migrate />} />
              <Route path="/projects/:projectId" element={<ProjectMemory />} />
              <Route path="/projects/:projectId/edit" element={<PackEditor />} />
              {/* The workshop is a thread now — old links land in the conversation they meant. */}
              <Route path="/projects/:projectId/workshop" element={<WorkshopRedirect />} />
              {/* THE THINGS YOU SET UP ONCE now live together under /admin.
                  Every old address still resolves: a bookmark should not die
                  for a navigation decision, and these four were top-level for
                  long enough that people have them saved. */}
              <Route path="/record" element={<Navigate to="/admin/record" replace />} />
              <Route path="/connections" element={<Navigate to="/admin/connections" replace />} />
              <Route path="/settings/billing" element={<Navigate to="/admin/billing" replace />} />
              <Route path="/billing" element={<Navigate to="/admin/billing" replace />} />
              <Route path="/tray" element={<Navigate to="/admin/apps" replace />} />
              <Route path="/admin/*" element={<Admin />} />
              <Route path="/ops/distribution/*" element={<OpsDistribution />} />
            </Routes>
            </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      </SignedIn>
    </>
  );
}

/**
 * WHAT THE TAB SAYS, DECIDED IN ONE PLACE.
 *
 * A per-page hook would work and would also be a rule five components have to
 * remember; the sixth one added later inherits whatever the last route set.
 * Here the path IS the answer, so a route that doesn't appear below falls back
 * to the product's own name rather than to a stale one.
 *
 * A PROJECT NAME NEVER APPEARS. A tab title is read by anyone at the screen
 * and copied into any link someone shares — "Loom · Selvedge" in a shared tab
 * strip leaks a customer's project to the room. The surface is named; its
 * contents are not.
 */
const SURFACE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['/continue', 'Continue a project'],
  ['/inbox', 'Threads'],
  ['/health', 'Health'],
  ['/projects', 'Projects'],
  ['/migrate', 'Migrate a project'],
  // Longest prefix first: /admin/billing must not be matched by /admin.
  ['/admin/preferences', 'Preferences'],
  ['/admin/record', 'Record'],
  ['/admin/apps', 'Your apps'],
  ['/admin/connections', 'Connections'],
  ['/admin/context', 'Context'],
  ['/admin/billing', 'Billing'],
  ['/admin/advanced', 'Under the hood'],
  ['/admin', 'Admin'],
  ['/ops/distribution', 'Distribution Ops'],
  ['/styleguide', 'Styleguide'],
];

function useRouteTitle(pathname: string): void {
  useEffect(() => {
    const match = SURFACE_NAMES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    document.title = match ? titleFor(match[1]) : DEFAULT_TITLE;
  }, [pathname]);
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
            <Suspense fallback={null}>
              <Styleguide />
            </Suspense>
          </main>
        }
      />
      {/* Public, signed in or out: documentation that vanishes once you have
          an account is documentation nobody can link to. */}
      <Route path="/docs" element={<Suspense fallback={null}><Docs /></Suspense>} />
      <Route path="/docs/:page" element={<Suspense fallback={null}><Docs /></Suspense>} />
      <Route path="/security" element={<Suspense fallback={null}><Security /></Suspense>} />
      <Route path="/changelog" element={<Suspense fallback={null}><Changelog /></Suspense>} />
      <Route
        path="/operator/demo-login"
        element={
          <ClerkLoaded>
            <Suspense fallback={null}>
              <DemoLoginTransfer />
            </Suspense>
          </ClerkLoaded>
        }
      />
      {/* The isolated marketing seed's live app. Public because it contains no
          customer data and must render inside the signed preview relay. */}
      <Route path="/demo-apps/relay" element={<Suspense fallback={null}><DemoAppPreview /></Suspense>} />
      <Route path="*" element={<AuthedApp />} />
    </Routes>
  );
}
