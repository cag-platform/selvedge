import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App.js';
import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// /styleguide is tokens-only and public; it must render (and be
// screenshot-testable in dev) with no Clerk configured at all.
if (!publishableKey && window.location.pathname.startsWith('/styleguide')) {
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
