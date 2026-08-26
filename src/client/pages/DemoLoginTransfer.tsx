import { useEffect, useRef, useState } from 'react';
import { useClerk } from '@clerk/clerk-react';
import {
  accountPortalUrlFromDemoTransfer,
  DEMO_WEB_TRANSFER_PATH,
} from '../../shared/demoLoginTransfer.js';
import { SelvedgeLockup } from '../components/Logo.js';

/**
 * Operator-only handoff for capture sessions.
 *
 * Clerk's hosted sign-in keeps the browser's current session when one already
 * exists, which can make a valid demo ticket appear to work while leaving the
 * operator in an unrelated tenant. Clear every Clerk session on this browser
 * before forwarding the one-use ticket. The ticket remains in the fragment
 * and is removed from browser history before any asynchronous work begins.
 */
export function DemoLoginTransfer() {
  const clerk = useClerk();
  const started = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // React Strict Mode replays effects during development. A sign-in token is
    // single-use, so this handoff must run only once for this component.
    if (started.current) return;
    started.current = true;

    let accountPortalUrl: string;
    try {
      accountPortalUrl = accountPortalUrlFromDemoTransfer(window.location.href);
    } catch {
      window.history.replaceState(null, '', DEMO_WEB_TRANSFER_PATH);
      setProblem('This demo login link is malformed. Mint a new operator link and try again.');
      return;
    }

    // Remove the credential before Clerk, browser extensions, or a copied URL
    // can preserve it. No sessionId means Clerk clears every active session on
    // this browser, eliminating the wrong-tenant ambiguity.
    window.history.replaceState(null, '', DEMO_WEB_TRANSFER_PATH);
    void clerk.signOut({ redirectUrl: accountPortalUrl }).catch(() => {
      setProblem('Selvedge could not clear this browser session. Mint a new operator link and try again.');
    });
  }, [clerk]);

  return (
    <main
      className="product-shell flex min-h-screen items-center justify-center bg-paper px-6 text-ink"
      data-theme="light"
    >
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <SelvedgeLockup tone="ink" className="h-10 w-auto" />
        {problem ? (
          <>
            <p role="alert" className="text-body font-medium text-ink">
              {problem}
            </p>
            <p className="text-meta text-ink-dim">No account was opened.</p>
          </>
        ) : (
          <>
            <p role="status" className="text-body font-medium text-ink">
              Opening the isolated demo workspace…
            </p>
            <p className="text-meta text-ink-dim">Existing Selvedge sessions in this browser will be signed out.</p>
          </>
        )}
      </div>
    </main>
  );
}
