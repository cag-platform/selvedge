import { NavLink } from 'react-router-dom';
import { OrganizationSwitcher, UserButton } from '@clerk/clerk-react';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-inset px-3 py-1.5 text-body font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass ${
    isActive ? 'bg-ink text-panel' : 'text-ink-dim hover:bg-panel-soft hover:text-ink'
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
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="mr-3 text-headline font-display font-medium text-ink">Selvedge</span>
          <NavLink to="/" end className={linkClass}>
            Today
          </NavLink>
          <NavLink to="/projects" className={linkClass}>
            Projects
          </NavLink>
          <NavLink to="/tray" className={linkClass}>
            Unsorted
          </NavLink>
          <NavLink to="/admin" className={linkClass}>
            Admin
          </NavLink>
        </div>
        <div className="flex items-center gap-3">
          <OrganizationSwitcher />
          <UserButton />
        </div>
      </div>
    </header>
  );
}
