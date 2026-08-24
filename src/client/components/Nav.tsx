import { NavLink } from 'react-router-dom';
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

export function Nav() {
  return (
    <header
      className="border-b border-hairline"
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
            <SelvedgeLockup tone="chalk" className="hidden h-7 w-auto sm:block" />
            <SelvedgeMark tone="chalk" className="h-7 w-auto sm:hidden" />
          </NavLink>
          <nav aria-label="Primary" className="flex min-w-0 items-center gap-0.5 sm:gap-1">
            <NavLink to="/inbox" className={linkClass}>
              Inbox
            </NavLink>
            <NavLink to="/projects" className={linkClass}>
              Projects
            </NavLink>
            {/* Everything you set up once: the record, the keys, the money.
                `end` is deliberately absent — /admin/connections and the rest
                are Admin too, and the tab should stay lit while you are in one. */}
            <NavLink to="/admin" className={linkClass}>
              Admin
            </NavLink>
          </nav>
        </div>
        {/* The org name is the first thing to give up room, and the avatar the
            last: you can always tell which account you are in from the picture,
            and never from a name clipped to three letters. */}
        <div className="flex min-w-0 shrink items-center gap-2 sm:gap-3">
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
