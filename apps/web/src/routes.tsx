import type { UserRole } from '@meridian/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { EmptyState, Loading } from './components/ui';
import { isPlatformAdminRole, isWorkerRole, useAuth } from './lib/auth';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';

/*
 * Every page is loaded lazily: the browser downloads a page's code the first
 * time it is visited, so the login screen does not pay for the payroll screen.
 */
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const WorkersPage = lazy(() => import('./pages/workers/WorkersPage'));
const HireWorkerPage = lazy(() => import('./pages/workers/HireWorkerPage'));
const WorkerDetailPage = lazy(() => import('./pages/workers/WorkerDetailPage'));
const CostCalculatorPage = lazy(() => import('./pages/quotes/CostCalculatorPage'));
const CountriesPage = lazy(() => import('./pages/countries/CountriesPage'));
const ContractsPage = lazy(() => import('./pages/contracts/ContractsPage'));
const ContractDetailPage = lazy(() => import('./pages/contracts/ContractDetailPage'));
const TimeOffPage = lazy(() => import('./pages/time-off/TimeOffPage'));
const ExpensesPage = lazy(() => import('./pages/expenses/ExpensesPage'));
const PortalHomePage = lazy(() => import('./pages/portal/PortalHomePage'));
const PayrollRunsPage = lazy(() => import('./pages/payroll/PayrollRunsPage'));
const PayrollRunDetailPage = lazy(() => import('./pages/payroll/PayrollRunDetailPage'));
const InvoicesPage = lazy(() => import('./pages/invoices/InvoicesPage'));
const InvoiceDetailPage = lazy(() => import('./pages/invoices/InvoiceDetailPage'));
const PayslipsPage = lazy(() => import('./pages/payslips/PayslipsPage'));
const TeamPage = lazy(() => import('./pages/settings/TeamPage'));
const OrganizationSettingsPage = lazy(() => import('./pages/settings/OrganizationSettingsPage'));
const AuditLogPage = lazy(() => import('./pages/audit/AuditLogPage'));
const OrganizationsPage = lazy(() => import('./pages/admin/OrganizationsPage'));

const STAFF: UserRole[] = ['platform_admin', 'client_admin', 'client_manager'];
const ADMINS: UserRole[] = ['platform_admin', 'client_admin'];

/** Signed-in only. Remembers where you were going so login can send you back. */
function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Signed-OUT only (login, register): a signed-in user is sent home. */
function RequireGuest() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <Loading />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * Role guard for a group of routes. This is a courtesy to the user (no dead
 * pages), not security: the API would answer 403 anyway.
 */
function RequireRole({ roles }: { roles: UserRole[] }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) {
    return (
      <EmptyState
        title="You don't have access to this page"
        description="Ask an administrator if you think this is a mistake."
      />
    );
  }
  return <Outlet />;
}

/** Tenant pages need a tenant. A platform admin who has not picked one is sent to pick. */
function RequireOrg() {
  const { user, hasOrgContext } = useAuth();
  if (user && isPlatformAdminRole(user) && !hasOrgContext) {
    return <Navigate to="/admin/organizations" replace />;
  }
  return <Outlet />;
}

/** "/" means different things to different people. */
function HomePage() {
  const { user } = useAuth();
  if (user && isWorkerRole(user)) return <PortalHomePage />;
  return <DashboardPage />;
}

const page = (node: ReactNode) => <Suspense fallback={<Loading />}>{node}</Suspense>;

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RequireGuest />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      {/* Reachable signed in or out: accepting an invite replaces the current session. */}
      <Route path="/accept-invite" element={<AcceptInvitePage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          {/* Platform-level pages: no tenant needed */}
          <Route element={<RequireRole roles={['platform_admin']} />}>
            <Route path="/admin/organizations" element={page(<OrganizationsPage />)} />
            <Route path="/countries" element={page(<CountriesPage />)} />
          </Route>

          <Route element={<RequireOrg />}>
            {/* Everyone */}
            <Route path="/" element={page(<HomePage />)} />
            <Route path="/contracts" element={page(<ContractsPage />)} />
            <Route path="/contracts/:id" element={page(<ContractDetailPage />)} />
            <Route path="/time-off" element={page(<TimeOffPage />)} />
            <Route path="/expenses" element={page(<ExpensesPage />)} />
            <Route path="/payslips" element={page(<PayslipsPage />)} />

            {/* Client staff + platform admins */}
            <Route element={<RequireRole roles={STAFF} />}>
              <Route path="/people" element={page(<WorkersPage />)} />
              <Route path="/people/new" element={page(<HireWorkerPage />)} />
              <Route path="/people/:id" element={page(<WorkerDetailPage />)} />
              <Route path="/calculator" element={page(<CostCalculatorPage />)} />
              <Route path="/payroll" element={page(<PayrollRunsPage />)} />
              <Route path="/payroll/:id" element={page(<PayrollRunDetailPage />)} />
              <Route path="/invoices" element={page(<InvoicesPage />)} />
              <Route path="/invoices/:id" element={page(<InvoiceDetailPage />)} />
              <Route path="/team" element={page(<TeamPage />)} />
            </Route>

            {/* Admins only */}
            <Route element={<RequireRole roles={ADMINS} />}>
              <Route path="/audit" element={page(<AuditLogPage />)} />
              <Route path="/settings" element={page(<OrganizationSettingsPage />)} />
            </Route>
          </Route>

          <Route
            path="*"
            element={<EmptyState title="Page not found" description="That address does not exist." />}
          />
        </Route>
      </Route>
    </Routes>
  );
}
