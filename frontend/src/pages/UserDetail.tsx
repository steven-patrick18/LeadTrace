import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';

interface Overview {
  user: {
    id: number; name: string; email: string; isActive: boolean; batchId: string | null; createdAt: string;
    role: { id: number; roleCode: string; displayName: string };
    reportsTo: { id: number; name: string } | null;
  };
  stats: {
    createdCount: number; activeAssigned: number; callsLogged: number; transfersRaised: number;
    leadsReceived: number; closedWon: number; closedLost: number; comments: number;
  };
  assignedLeads: Array<{ id: number; firstName: string; lastName: string; primaryPhone: string; currentTier: string; status: string; updatedAt: string }>;
  recentActivity: Array<{ id: number; type: string; detail: string; createdAt: string; leadId: number }>;
  desk: { code: string; since: string } | null;
}

interface Role { id: number; roleCode: string; displayName: string }

/** Full user page: profile edit (incl. Batch ID assignment), performance,
 *  assigned leads, and activity. Opened by clicking a user anywhere. */
export function UserDetail() {
  const { id } = useParams();
  const { scope, user: me, can } = useAuth();
  const readOnly = scope('manage_users') === 'VIEW';
  const [data, setData] = useState<Overview | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setData(await get<Overview>(`/users/${id}/overview`));
    setRoles(await get<Role[]>('/users/roles'));
  };
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : 'Failed')); /* eslint-disable-next-line */ }, [id]);

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const u = data.user;
  const winRate = data.stats.closedWon + data.stats.closedLost > 0
    ? Math.round((data.stats.closedWon / (data.stats.closedWon + data.stats.closedLost)) * 100)
    : null;

  const flash = (m: string) => { setMsg(m); setError(''); setTimeout(() => setMsg(''), 3000); };
  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : 'Failed'); setMsg(''); };

  return (
    <div>
      <p><Link to="/users">← All users</Link></p>
      <h1>
        {u.name} <span className="badge tier">{u.role.displayName}</span>{' '}
        {u.isActive ? <span className="badge CLOSED_WON">active</span> : <span className="badge CLOSED_LOST">disabled</span>}
        {data.desk && <span className="muted" style={{ fontSize: '0.85rem', marginLeft: 10 }}>🪑 on {data.desk.code} since {new Date(data.desk.since).toLocaleTimeString()}</span>}
      </h1>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="grid cols4">
        <div className="card stat"><div className="num">{data.stats.activeAssigned}</div><div className="lbl">Active leads</div></div>
        <div className="card stat"><div className="num">{data.stats.callsLogged}</div><div className="lbl">Calls logged</div></div>
        <div className="card stat">
          <div className="num" style={{ color: 'var(--green)' }}>{data.stats.closedWon}</div>
          <div className="lbl">Won{winRate !== null ? ` (${winRate}% win rate)` : ''}</div>
        </div>
        <div className="card stat"><div className="num">{data.stats.leadsReceived}</div><div className="lbl">Leads received</div></div>
      </div>
      <p className="muted" style={{ fontSize: '0.82rem' }}>
        Created {data.stats.createdCount} leads · transfers raised {data.stats.transfersRaised} · lost{' '}
        {data.stats.closedLost} · comments {data.stats.comments} · member since {new Date(u.createdAt).toLocaleDateString()}
      </p>

      <div className="grid cols2">
        <EditProfile
          key={u.id + u.email + (u.batchId ?? '')}
          u={u}
          roles={roles}
          readOnly={readOnly}
          isMe={u.id === me?.id}
          onSaved={async (m) => { flash(m); await load(); }}
          onErr={fail}
        />

        <div className="card">
          <h2>Assigned leads ({data.assignedLeads.length})</h2>
          {data.assignedLeads.length === 0 && <span className="muted">None.</span>}
          {data.assignedLeads.map((l) => (
            <div key={l.id} style={{ fontSize: '0.86rem', padding: '4px 0' }}>
              <Link to={`/leads/${l.id}`}>#{l.id} {l.firstName} {l.lastName}</Link>{' '}
              <span className="badge tier">{l.currentTier}</span>{' '}
              <span className={`badge ${l.status}`}>{l.status}</span>{' '}
              <span className="muted">{l.primaryPhone}</span>
            </div>
          ))}
          {can('view_all_leads') && (
            <p style={{ marginTop: 10 }}>
              <Link to={`/leads?scope=all&assignedTo=${u.id}&who=${encodeURIComponent(u.name)}`}>See all their leads →</Link>
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Recent activity</h2>
        {data.recentActivity.length === 0 && <span className="muted">None.</span>}
        <ul className="timeline">
          {data.recentActivity.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.type}</strong> — {a.detail}{' '}
                <Link to={`/leads/${a.leadId}`} className="muted" style={{ fontSize: '0.78rem' }}>lead #{a.leadId}</Link>
              </div>
              <div className="when">{new Date(a.createdAt).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EditProfile({
  u, roles, readOnly, isMe, onSaved, onErr,
}: {
  u: Overview['user'];
  roles: Role[];
  readOnly: boolean;
  isMe: boolean;
  onSaved: (msg: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [name, setName] = useState(u.name);
  const [email, setEmail] = useState(u.email);
  const [roleId, setRoleId] = useState(String(u.role.id));
  const [batchId, setBatchId] = useState(u.batchId ?? '');
  const [password, setPassword] = useState('');

  const dirty =
    name !== u.name || email !== u.email || roleId !== String(u.role.id) ||
    batchId !== (u.batchId ?? '') || password.length > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await patch(`/users/${u.id}`, {
        ...(name !== u.name ? { name } : {}),
        ...(email !== u.email ? { email } : {}),
        ...(roleId !== String(u.role.id) ? { roleId: Number(roleId) } : {}),
        ...(batchId && batchId !== u.batchId ? { batchId } : {}),
        ...(password ? { password } : {}),
      });
      setPassword('');
      onSaved('Profile saved.');
    } catch (err) {
      onErr(err);
    }
  };

  const regenerate = async () => {
    try {
      const r = await post<{ batchId: string }>(`/users/${u.id}/regenerate-batch-id`);
      setBatchId(r.batchId);
      onSaved(`New batch ID assigned: ${r.batchId}`);
    } catch (err) {
      onErr(err);
    }
  };

  const toggleActive = async () => {
    try {
      await patch(`/users/${u.id}`, { isActive: !u.isActive });
      onSaved(u.isActive ? 'User deactivated.' : 'User activated.');
    } catch (err) {
      onErr(err);
    }
  };

  if (readOnly) {
    return (
      <div className="card">
        <h2>Profile</h2>
        <p className="muted" style={{ lineHeight: 1.9 }}>
          {u.email}<br />
          Role: {u.role.displayName}<br />
          Batch ID: <code>{u.batchId ?? '—'}</code><br />
          Reports to: {u.reportsTo?.name ?? '—'}
        </p>
        <p className="muted" style={{ fontSize: '0.78rem' }}>Editing requires full manage_users (admin).</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Edit profile</h2>
      <form onSubmit={save}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="field"><label>Name</label><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Email</label><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="field">
            <label>Role</label>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Batch ID (for ⚡ quick sessions)</label>
            <input
              value={batchId}
              onChange={(e) => setBatchId(e.target.value.toUpperCase())}
              placeholder="LT-XXXXXX"
              style={{ width: 150, fontFamily: 'monospace' }}
            />
          </div>
          <button type="button" className="ghost sm" onClick={regenerate} style={{ alignSelf: 'flex-end' }}>
            🎲 Random
          </button>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field">
            <label>Reset password (min 10 chars — leave blank to keep)</label>
            <input type="password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" style={{ width: 240 }} />
          </div>
        </div>
        <div className="row">
          <button type="submit" disabled={!dirty}>💾 Save profile</button>
          {!isMe && (
            <button type="button" className={u.isActive ? 'danger' : 'success'} onClick={toggleActive}>
              {u.isActive ? 'Deactivate user' : 'Activate user'}
            </button>
          )}
        </div>
      </form>
      <p className="muted" style={{ fontSize: '0.78rem', marginTop: 10 }}>
        Changing the batch ID immediately invalidates the old one for quick sessions. All edits are audited.
      </p>
    </div>
  );
}
