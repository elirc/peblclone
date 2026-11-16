import type { SessionUser } from '@meridian/shared';
import clsx from 'clsx';
import {
  Banknote,
  Building2,
  Calculator,
  CalendarDays,
  FileSignature,
  FileText,
  Globe2,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Settings,
  UserCog,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { isAdminRole, isPlatformAdminRole, isWorkerRole, useAuth, useUser } from '../../lib/auth';
import { humanize, initials } from '../../lib/format';
import { Badge } from '../ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match only the exact path (used for "/"). */
  end?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

/**
 * Navigation is derived from the user's role. This only decides what is SHOWN;
 * routes are guarded separately and the API enforces every permission itself.
 */
function navFor(user: SessionUser, hasOrgContext: boolean): NavSection[] {
  if (isWorkerRole(user)) {
    return [
      {
        items: [
          { to: '/', label: 'Home', icon: Home, end: true },
          { to: '/contracts', label: 'My agreement', icon: FileSignature },
          { to: '/time-off', label: 'Time off', icon: CalendarDays },
          { to: '/expenses', label: 'Expenses', icon: Receipt },
          { to: '/payslips', label: 'Payslips', icon: Wallet },
        ],
      },
    ];
  }

  const sections: NavSection[] = [];
  if (hasOrgContext) {
    sections.push(
      {
        items: [
          { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
          { to: '/people', label: 'People', icon: Users },
          { to: '/calculator', label: 'Cost calculator', icon: Calculator },
        ],
      },
      {
        title: 'Manage',
        items: [
          { to: '/contracts', label: 'Contracts', icon: FileSignature },
          { to: '/time-off', label: 'Time off', icon: CalendarDays },
          { to: '/expenses', label: 'Expenses', icon: Receipt },
        ],
      },
      {
        title: 'Finance',
        items: [
          { to: '/payroll', label: 'Payroll', icon: Banknote },
          { to: '/invoices', label: 'Invoices', icon: FileText },
          { to: '/payslips', label: 'Payslips', icon: Wallet },
        ],
      },
    );
    const company: NavItem[] = [{ to: '/team', label: 'Team', icon: UserCog }];
    if (isAdminRole(user)) {
      company.push(
        { to: '/audit', label: 'Audit log', icon: History },
        { to: '/settings', label: 'Settings', icon: Settings },
      );
    }
    sections.push({ title: 'Company', items: company });
  }
  if (isPlatformAdminRole(user)) {
    sections.push({
      title: 'Platform',
      items: [
        { to: '/admin/organizations', label: 'Organizations', icon: Building2 },
        { to: '/countries', label: 'Countries', icon: Globe2 },
      ],
    });
  }
  return sections;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const user = useUser();
  const { hasOrgContext } = useAuth();
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5">
      <div className="flex items-center gap-2 px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 text-white">
          <Globe2 className="h-5 w-5" aria-hidden />
        </div>
        <span className="text-lg font-semibold tracking-tight text-ink-900">Meridian</span>
      </div>
      {navFor(user, hasOrgContext).map((section, index) => (
        <div key={section.title ?? index}>
          {section.title && (
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
              {section.title}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                      isActive
                        ? 'bg-brand-50 text-brand-800'
                        : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserMenu() {
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <p className="text-sm font-medium text-ink-900">{user.fullName}</p>
        <p className="text-xs text-ink-500">{humanize(user.role)}</p>
      </div>
      <div
        aria-hidden
        className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800"
      >
        {initials(user.fullName)}
      </div>
      <button
        type="button"
        onClick={async () => {
          await logout();
          navigate('/login');
        }}
        className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
        aria-label="Log out"
        title="Log out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The frame around every signed-in page: sidebar, top bar, and the routed page. */
export function AppShell() {
  const user = useUser();
  const { actingOrgId, setActingOrg } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">
        <Sidebar />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-64 bg-white shadow-xl">
            <button
              type="button"
              className="absolute right-3 top-4 rounded-md p-1 text-ink-500"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-ink-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="rounded-md p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            {user.organizationName && (
              <span className="truncate text-sm font-medium text-ink-700">
                {user.organizationName}
              </span>
            )}
            {isPlatformAdminRole(user) &&
              (actingOrgId ? (
                <span className="flex items-center gap-2 text-sm">
                  <Badge tone="purple">Working inside a client organization</Badge>
                  <button
                    type="button"
                    className="text-brand-700 underline-offset-2 hover:underline"
                    onClick={() => {
                      setActingOrg(null);
                      navigate('/admin/organizations');
                    }}
                  >
                    Exit
                  </button>
                </span>
              ) : (
                <Badge tone="purple">Platform admin</Badge>
              ))}
          </div>
          <UserMenu />
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
