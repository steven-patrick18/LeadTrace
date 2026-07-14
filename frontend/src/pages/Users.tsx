import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';

interface UserRow {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
  batchId: string | null;
  role: { id: number; roleCode: string; displayName: string };
  reportsTo: { id: number; name: string } | null;
}
interface Role { id: number; roleCode: string; displayName: string }

interface Overview {
  user: { id: number; name: string; email: string; role: { displayName: string } };
  stats: {
    createdCount: number; activeAssigned: number; callsLogged: number; transfersRaised: number;
    leadsReceived: number; closedWon: number; closedLost: number; comments: number;
  };
  assignedLeads: Array<{ id: number; firstName: string; lastName: string; primaryPhone: string; currentTier: string; status: string; updatedAt: string }>;
  recentActivity: Array<{ id: number; type: string; detail: string; createdAt: string; leadId: number }>;
  desk: { code: string; since: string } | null;
}

export function Users() {
  const { scope, user: me } = useAuth();
  const readOnly = scope('manage_users') === 'VIEW';
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', roleId: '' });
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setUsers(await get<UserRow[]>('/users'));
    setRoles(await get<Role[]>('/users/roles'));
  };
  useEffect(() => { load(); }, []);

  const createUser = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await post('/users', { ...form, roleId: Number(form.roleId) });
      setShowNew(false);
      setForm({ name: '', email: '', password: '', roleId: '' });
      setMsg('User created.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const toggleActive = async (u: UserRow) => {
    setError('');
    try {
      await patch(`/users/${u.id}`, { isActive: !u.isActive });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div>
      <h1>Users {readOnly && <span className="muted" style={{ fontSize: '0.8rem' }}>(view only)</span>}</h1>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <div className="card">
        {!readOnly && (
          <button style={{ marginBottom: 14 }} onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Cancel' : '+ New user'}
          </button>
        )}
        {showNew && (
          <form onSubmit={createUser} className="row" style={{ marginBottom: 16 }}>
            <div className="field"><label>Name</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Email</label><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label>Password (min 10)</label><input required type="password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="field">
              <label>Role</label>
              <select required value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                <option value="">— pick —</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
              </select>
            </div>
            <button type="submit">Create</button>
          </form>
        )}
        <table>
          <thead>
            <tr><th></th><th>Name</th><th>Email</th><th>Role</th><th>Batch ID</th><th>Status</th>{!readOnly && <th></th>}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRowExpandable
                key={u.id}
                u={u}
                isMe={u.id === me?.id}
                readOnly={readOnly}
                onToggleActive={() => toggleActive(u)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRowExpandable({
  u, isMe, readOnly, onToggleActive,
}: {
  u: UserRow;
  isMe: boolean;
  readOnly: boolean;
  onToggleActive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !overview) {
      try {
        setOverview(await get<Overview>(`/users/${u.id}/overview`));
      } catch {
        /* ignore */
      }
    }
  };

  const winRate = overview
    ? overview.stats.closedWon + overview.stats.closedLost > 0
      ? Math.round((overview.stats.closedWon / (overview.stats.closedWon + overview.stats.closedLost)) * 100)
      : null
    : null;

  return (
    <>
      <tr style={{ cursor: 'pointer' }} onClick={toggle}>
        <td style={{ width: 26 }}>{open ? '▾' : '▸'}</td>
        <td>{u.name}{isMe && <span className="muted"> (you)</span>}</td>
        <td className="muted">{u.email}</td>
        <td><span className="badge tier">{u.role.displayName}</span></td>
        <td className="muted" style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{u.batchId ?? '—'}</td>
        <td>{u.isActive ? <span className="badge CLOSED_WON">active</span> : <span className="badge CLOSED_LOST">disabled</span>}</td>
        {!readOnly && (
          <td onClick={(e) => e.stopPropagation()}>
            {!isMe && (
              <button className="ghost sm" onClick={onToggleActive}>
                {u.isActive ? 'Deactivate' : 'Activate'}
              </button>
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={readOnly ? 6 : 7} style={{ background: 'var(--panel2)', borderRadius: 8 }}>
            {!overview ? (
              <span className="muted">Loading…</span>
            ) : (
              <div style={{ padding: '10px 6px' }}>
                <div className="grid cols4" style={{ marginBottom: 12 }}>
                  <div className="stat"><div className="num">{overview.stats.activeAssigned}</div><div className="lbl">Active leads</div></div>
                  <div className="stat"><div className="num">{overview.stats.callsLogged}</div><div className="lbl">Calls logged</div></div>
                  <div className="stat">
                    <div className="num" style={{ color: 'var(--green)' }}>{overview.stats.closedWon}</div>
                    <div className="lbl">Won{winRate !== null ? ` (${winRate}% win rate)` : ''}</div>
                  </div>
                  <div className="stat"><div className="num">{overview.stats.leadsReceived}</div><div className="lbl">Leads received</div></div>
                </div>
                <p className="muted" style={{ fontSize: '0.8rem' }}>
                  Created {overview.stats.createdCount} · transfers raised {overview.stats.transfersRaised} · lost{' '}
                  {overview.stats.closedLost} · comments {overview.stats.comments} ·{' '}
                  {overview.desk
                    ? <>🪑 on <strong>{overview.desk.code}</strong> since {new Date(overview.desk.since).toLocaleTimeString()}</>
                    : 'not at a desk'}
                </p>
                <div className="grid cols2">
                  <div>
                    <h2 style={{ fontSize: '0.9rem' }}>Assigned leads</h2>
                    {overview.assignedLeads.length === 0 && <span className="muted">None.</span>}
                    {overview.assignedLeads.map((l) => (
                      <div key={l.id} style={{ fontSize: '0.84rem', padding: '3px 0' }}>
                        <Link to={`/leads/${l.id}`}>#{l.id} {l.firstName} {l.lastName}</Link>{' '}
                        <span className="badge tier">{l.currentTier}</span>{' '}
                        <span className={`badge ${l.status}`}>{l.status}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h2 style={{ fontSize: '0.9rem' }}>Recent activity</h2>
                    {overview.recentActivity.length === 0 && <span className="muted">None.</span>}
                    {overview.recentActivity.map((a) => (
                      <div key={a.id} style={{ fontSize: '0.8rem', padding: '3px 0' }}>
                        <strong>{a.type}</strong> — {a.detail.slice(0, 70)}{a.detail.length > 70 ? '…' : ''}{' '}
                        <span className="muted">({new Date(a.createdAt).toLocaleString()})</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
