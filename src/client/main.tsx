import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App.js';
import { Landing } from './pages/Landing.js';
import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// A local-only route for visual QA when a Clerk key is intentionally absent.
// It never exists in a production build and does not alter authenticated routing.
const landingPreview = import.meta.env.DEV && window.location.pathname === '/landing-preview';

/**
 * PAGES THAT DO NOT NEED AN AUTH PROVIDER TO EXIST.
 *
 * The styleguide was here first, so it could be screenshot-tested with no
 * Clerk configured. The same argument turns out to apply to everything else
 * public: documentation that disappears when the auth vendor's key is missing
 * is documentation you cannot link to from an incident, and a security page
 * that requires a third party's script to load is making a claim it can't
 * keep.
 *
 * These routes are matched in App.tsx BEFORE the authed tree, so they render
 * perfectly well without a provider. The landing is deliberately NOT in this
 * list: it renders inside <SignedOut>, which is Clerk's, and a landing page
 * that loaded but whose "Start free" button did nothing would be worse than
 * the honest configuration notice below.
 */
const PUBLIC_WITHOUT_AUTH = ['/styleguide', '/docs', '/security', '/changelog'];

if (landingPreview) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><BrowserRouter><Landing /></BrowserRouter></React.StrictMode>,
  );
} else if (!publishableKey && PUBLIC_WITHOUT_AUTH.some((p) => window.location.pathname.startsWith(p))) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
} else if (!publishableKey) {
  // A blank white screen is the worst failure mode — it looks like the whole app
  // is down. Render a legible message instead, so a misconfigured build (the key
  // must be present at BUILD time, not just runtime) is diagnosable at a glance.
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <div style={{ maxWidth: 520, margin: '15vh auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif', color: '#1a1f26' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Selvedge isn’t finished configuring.</h1>
      <p style={{ lineHeight: 1.5, color: '#5f6a77' }}>
        Sign-in can’t load because <code>VITE_CLERK_PUBLISHABLE_KEY</code> wasn’t set when this build was made.
        It has to be present at build time, not just at runtime — set it in the service’s build variables and redeploy.
      </p>
    </div>,
  );
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ClerkProvider>
    </React.StrictMode>,
  );
}
