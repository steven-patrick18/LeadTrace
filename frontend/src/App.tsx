import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Bell } from './components/Bell';
import { ApiCosts } from './pages/ApiCosts';
import { Dashboard } from './pages/Dashboard';
import { LeadDetail } from './pages/LeadDetail';
import { Login } from './pages/Login';
import { Matrix } from './pages/Matrix';
import { MyLeads } from './pages/MyLeads';
import { RoutingQueue } from './pages/RoutingQueue';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
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
        {can('route_leads') && <Nav to="/routing" label="Routing Queue" />}
        {can('view_reports_own') && <Nav to="/dashboard" label="Dashboard" />}
        {can('view_api_costs') && <Nav to="/api-costs" label="API Costs" />}
        {can('manage_users') && <Nav to="/users" label="Users" />}
        {can('manage_permissions') && <Nav to="/permissions" label="Permissions" />}
        {(can('manage_providers') || can('system_lockdown')) && <Nav to="/settings" label="Settings" />}
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
          <Bell />
        </div>
        <Routes>
          <Route path="/" element={<Navigate to={can('route_leads') ? '/routing' : can('search_providers') ? '/search' : '/leads'} />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/leads" element={<MyLeads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/routing" element={<RoutingQueue />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/api-costs" element={<ApiCosts />} />
          <Route path="/users" element={<Users />} />
          <Route path="/permissions" element={<Matrix />} />
          <Route path="/settings" element={<SettingsPage />} />
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
