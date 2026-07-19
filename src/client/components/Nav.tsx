import { NavLink } from 'react-router-dom';
import { OrganizationSwitcher, UserButton } from '@clerk/clerk-react';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`;

export function Nav() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="mr-3 text-lg font-semibold text-slate-900">Silta</span>
          <NavLink to="/" end className={linkClass}>
            Today
          </NavLink>
          <NavLink to="/projects" className={linkClass}>
            Projects
          </NavLink>
          <NavLink to="/tray" className={linkClass}>
            Unsorted
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
