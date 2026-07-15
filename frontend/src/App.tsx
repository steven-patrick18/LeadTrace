import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Bell } from './components/Bell';
import { DeskWidget } from './components/DeskWidget';
import { SessionSwitch } from './components/SessionSwitch';
import { ThemeToggle } from './components/ThemeToggle';
import { DeskFloor } from './pages/DeskFloor';
import { ApiCosts } from './pages/ApiCosts';
import { Dashboard } from './pages/Dashboard';
import { DncList } from './pages/DncList';
import { LeadDetail } from './pages/LeadDetail';
import { Login } from './pages/Login';
import { Matrix } from './pages/Matrix';
import { MyLeads } from './pages/MyLeads';
import { ProviderDetail } from './pages/ProviderDetail';
import { Providers } from './pages/Providers';
import { Reports } from './pages/Reports';
import { RoutingQueue } from './pages/RoutingQueue';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemHealth } from './pages/SystemHealth';
import { UserDetail } from './pages/UserDetail';
import { Users } from './pages/Users';

export default function App() {
  const { user, loading, can, logout } = useAuth();

  if (loading) return <div className="login-wrap muted">Loading…</div>;
  if (!user) return <Login />;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">
          Lead<span>Trace</span>
        </div>
        {can('search_providers') && <Nav to="/search" label="Search" />}
        <Nav to="/leads" label="My Leads" />
        {can('route_leads') && <Nav to="/routing" label="Manager Bucket" />}
        {can('view_reports_own') && <Nav to="/dashboard" label="Dashboard" />}
        {can('view_reports_team') && <Nav to="/reports" label="Reports" />}
        {can('view_api_costs') && <Nav to="/api-costs" label="API Costs" />}
        {can('manage_desks') && <Nav to="/desk-floor" label="Desk Floor" />}
        {can('manage_dnc_optout') && <Nav to="/dnc" label="DNC List" />}
        {can('manage_users') && <Nav to="/users" label="Users" />}
        {can('manage_permissions') && <Nav to="/permissions" label="Permissions" />}
        {can('manage_providers') && <Nav to="/providers" label="Providers" />}
        {(can('manage_permissions') || can('system_lockdown')) && <Nav to="/settings" label="Settings" />}
        {can('system_lockdown') && <Nav to="/system" label="System" />}
        <div className="spacer" />
        <div className="whoami">
          {user.name}
          <br />
          <span style={{ color: 'var(--accent2)' }}>{user.roleName}</span>
          <br />
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>
            Sign out
          </a>
        </div>
      </nav>
      <main className="main">
        <div className="topbar">
          <ThemeToggle />
          <SessionSwitch />
          <DeskWidget />
          <Bell />
        </div>
        <Routes>
          <Route path="/" element={<Navigate to={can('route_leads') ? '/routing' : can('search_providers') ? '/search' : '/leads'} />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/leads" element={<MyLeads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/routing" element={<RoutingQueue />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/api-costs" element={<ApiCosts />} />
          <Route path="/desk-floor" element={<DeskFloor />} />
          <Route path="/dnc" element={<DncList />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="/permissions" element={<Matrix />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/providers/:id" element={<ProviderDetail />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/system" element={<SystemHealth />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function Nav({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}>
      {label}
    </NavLink>
  );
}
