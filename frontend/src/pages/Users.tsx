import { FormEvent, useEffect, useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';

interface UserRow {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
  role: { id: number; roleCode: string; displayName: string };
  reportsTo: { id: number; name: string } | null;
}
interface Role { id: number; roleCode: string; displayName: string }

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
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>{!readOnly && <th></th>}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.id === me?.id && <span className="muted"> (you)</span>}</td>
                <td className="muted">{u.email}</td>
                <td><span className="badge tier">{u.role.displayName}</span></td>
                <td>{u.isActive ? <span className="badge CLOSED_WON">active</span> : <span className="badge CLOSED_LOST">disabled</span>}</td>
                {!readOnly && (
                  <td>
                    {u.id !== me?.id && (
                      <button className="ghost sm" onClick={() => toggleActive(u)}>
                        {u.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
