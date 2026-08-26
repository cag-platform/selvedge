import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { OrganizationSwitcher, UserButton } from '@clerk/clerk-react';
import { SelvedgeLockup, SelvedgeMark } from './Logo.js';

/**
 * THREE PLACES, NOT SIX.
 *
 * This bar carried Inbox, Record, Projects, Connections, Billing and Admin —
 * six peers, of which two are where you work and four are things you set up
 * once and then never think about again. A row of equals teaches nobody where
 * to go, and it made the first question on every visit "which of these did I
 * want?" rather than "what needs me?".
 *
 * So: the workbench, the things it works on, and everything else. Record,
 * Connections and Billing live inside Admin now — their addresses still work,
 * because a bookmark should not die for a navigation decision.
 *
 * IT IS ALSO WHY THE APP WORKED ON A PHONE FOR THE FIRST TIME. Six links plus
 * a logo, an org switcher and an avatar in one rigid row measured about 700px,
 * which forced every page in the product to scroll sideways at 430px wide —
 * not the Inbox, not Billing: all of them, because the overflow was in the
 * chrome above them. Three links fit. The rest of the responsiveness in here is
 * belt and braces: the label shortens, the org name gives up its width first,
 * and nothing is allowed to push the document wider than the screen.
 */

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-inset px-2.5 py-1.5 text-body font-medium whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright sm:px-3 ${
    isActive ? 'bg-action text-ink' : 'text-ink-dim hover:bg-panel-soft hover:text-ink'
  }`;

export function Nav({ theme, resolvedTheme, onThemeChange }: {
  theme: 'light' | 'night' | 'system';
  resolvedTheme: 'light' | 'night';
  onThemeChange: (theme: 'light' | 'night' | 'system') => void;
}) {
  const pathname = useLocation().pathname;
  const workActive = pathname.startsWith('/inbox') || pathname === '/work';
  const secondaryMenu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!secondaryMenu.current?.contains(event.target as Node)) secondaryMenu.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        secondaryMenu.current?.removeAttribute('open');
        secondaryMenu.current?.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  const closeSecondaryMenu = () => secondaryMenu.current?.removeAttribute('open');
  return (
    <header
      className="relative z-50 border-b border-hairline"
      style={{
        background: 'var(--glass-fill)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
      }}
    >
      <div className="mx-auto flex h-[var(--nav-height)] max-w-6xl items-center justify-between gap-2 px-3 sm:px-4">
        {/* min-w-0 is what actually stops the overflow: without it a flex child
            refuses to shrink below its content, and the whole document widens
            to fit the nav rather than the nav fitting the document. */}
        <div className="flex min-w-0 items-center gap-1">
          <NavLink
            to="/"
            end
            aria-label="Selvedge — the workbench"
            className="mr-1 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright sm:mr-3"
          >
            {/* The full lockup needs room for the wordmark; below that the mark
                stands on its own rather than being squeezed into illegibility. */}
            <SelvedgeLockup tone={resolvedTheme === 'night' ? 'chalk' : 'ink'} className="hidden h-7 w-auto sm:block" />
            <SelvedgeMark tone={resolvedTheme === 'night' ? 'chalk' : 'ink'} className="h-7 w-auto sm:hidden" />
          </NavLink>
          <nav aria-label="Primary" className="flex min-w-0 items-center gap-0.5 sm:gap-1">
            <NavLink to="/" end className={linkClass}>
              Home
            </NavLink>
            <Link to="/inbox" className={linkClass({ isActive: workActive })} aria-current={workActive ? 'page' : undefined}>Work</Link>
            <NavLink to="/projects" className={linkClass}>
              Projects
            </NavLink>
            <Link to="/inbox?search=1" className={linkClass({ isActive: false })}>Search</Link>
          </nav>
        </div>
        {/* The org name is the first thing to give up room, and the avatar the
            last: you can always tell which account you are in from the picture,
            and never from a name clipped to three letters. */}
        <div className="flex min-w-0 shrink items-center gap-1.5 sm:gap-3">
          <details ref={secondaryMenu} className="relative shrink-0">
            <summary aria-label="Secondary navigation" className="cursor-pointer list-none rounded-inset px-2 py-1 text-body text-ink-dim hover:bg-panel-soft">•••</summary>
            <nav aria-label="Secondary" className="absolute right-0 z-50 mt-2 w-56 rounded-card border border-hairline bg-panel p-2 shadow-pane">
              <Link to="/admin/record" onClick={closeSecondaryMenu} className="block rounded-inset px-3 py-2 text-body text-ink-dim hover:bg-panel-soft">Record</Link>
              <Link to="/admin/connections" onClick={closeSecondaryMenu} className="block rounded-inset px-3 py-2 text-body text-ink-dim hover:bg-panel-soft">Connections</Link>
              <Link to="/admin" onClick={closeSecondaryMenu} className="block rounded-inset px-3 py-2 text-body text-ink-dim hover:bg-panel-soft">Admin</Link>
              <div className="mt-2 border-t border-hairline px-2 pt-3">
                <p className="text-label font-semibold uppercase tracking-widest text-ink-quiet">Appearance</p>
                <div className="mt-2 grid grid-cols-3 gap-1" role="group" aria-label="Color theme">
                  {(['light', 'night', 'system'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={theme === option}
                      onClick={() => {
                        onThemeChange(option);
                        closeSecondaryMenu();
                      }}
                      className={`rounded-inset px-2 py-1.5 text-meta capitalize focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${theme === option ? 'bg-action text-ink' : 'text-ink-dim hover:bg-panel-soft hover:text-ink'}`}
                    >
                      {option === 'night' ? 'Night' : option}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-meta text-ink-quiet">{theme === 'night' || (theme === 'system' && resolvedTheme === 'night') ? 'Night Weave' : 'Mineral light'}</p>
              </div>
            </nav>
          </details>
          <div className="min-w-0 truncate">
            <OrganizationSwitcher />
          </div>
          <div className="shrink-0">
            <UserButton />
          </div>
        </div>
      </div>
    </header>
  );
}
