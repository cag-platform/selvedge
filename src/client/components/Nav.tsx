import { NavLink } from 'react-router-dom';
import { OrganizationSwitcher, UserButton } from '@clerk/clerk-react';
import { SelvedgeLockup } from './Logo.js';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-inset px-3 py-1.5 text-body font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
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
      <div className="mx-auto flex h-[var(--nav-height)] max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-1">
          <NavLink to="/" end aria-label="Selvedge — Today" className="mr-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright">
            <SelvedgeLockup tone="chalk" className="h-7 w-auto" />
          </NavLink>
          <nav aria-label="Primary" className="flex items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              Today
            </NavLink>
            <NavLink to="/inbox" className={linkClass}>
              Inbox
            </NavLink>
            <NavLink to="/record" className={linkClass}>
              Record
            </NavLink>
            <NavLink to="/projects" className={linkClass}>
              Projects
            </NavLink>
            <NavLink to="/tray" className={linkClass}>
              Unsorted
            </NavLink>
            <NavLink to="/connections" className={linkClass}>
              Connections
            </NavLink>
            <NavLink to="/admin" className={linkClass}>
              Admin
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <OrganizationSwitcher />
          <UserButton />
        </div>
      </div>
    </header>
  );
}
