import { useEffect, useState } from 'react';
import { get, patch } from '../api';
import { useAuth } from '../auth';

interface MatrixData {
  permissionKeys: string[];
  roles: Array<{
    id: number;
    roleCode: string;
    displayName: string;
    permissions: Record<string, { allowed: boolean; scope: string }>;
  }>;
}

const SCOPES = ['ALL', 'OWN', 'ASSIGNED', 'VIEW'];

export function Matrix() {
  const { refreshPerms } = useAuth();
  const [data, setData] = useState<MatrixData | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => setData(await get<MatrixData>('/permissions/matrix'));
  useEffect(() => { load(); }, []);

  if (!data) return <div className="muted">Loading…</div>;

  const toggle = async (roleId: number, key: string, current: { allowed: boolean; scope: string } | undefined) => {
    setError('');
    setSaving(true);
    try {
      // Click cycles: denied → ALL → OWN → ASSIGNED → VIEW → denied
      let next: { allowed: boolean; scope: string };
      if (!current?.allowed) next = { allowed: true, scope: 'ALL' };
      else {
        const idx = SCOPES.indexOf(current.scope);
        next = idx >= SCOPES.length - 1 ? { allowed: false, scope: 'ALL' } : { allowed: true, scope: SCOPES[idx + 1] };
      }
      await patch(`/permissions/roles/${roleId}`, { permissionKey: key, ...next });
      await load();
      await refreshPerms();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const rename = async (roleId: number, current: string) => {
    const displayName = prompt('New display name for this role:', current);
    if (!displayName || displayName === current) return;
    await patch(`/permissions/roles/${roleId}/rename`, { displayName });
    await load();
  };

  const cellLabel = (p: { allowed: boolean; scope: string } | undefined) => {
    if (!p?.allowed) return <span style={{ color: 'var(--red)' }}>✗</span>;
    if (p.scope === 'ALL') return <span style={{ color: 'var(--green)' }}>✓</span>;
    return <span style={{ color: 'var(--amber)', fontSize: '0.72rem', fontWeight: 700 }}>{p.scope}</span>;
  };

  return (
    <div>
      <h1>Permission Matrix</h1>
      <p className="muted">
        Click a cell to cycle: denied → allowed (ALL) → OWN → ASSIGNED → VIEW → denied. Changes apply immediately —
        every edit is audited and takes effect without a deploy. Click a role name to rename it.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ opacity: saving ? 0.6 : 1 }}>
          <thead>
            <tr>
              <th>permission_key</th>
              {data.roles.map((r) => (
                <th key={r.id} style={{ textAlign: 'center', cursor: 'pointer' }} title="Click to rename" onClick={() => rename(r.id, r.displayName)}>
                  {r.displayName}
                  <div className="muted" style={{ fontSize: '0.65rem', textTransform: 'none' }}>{r.roleCode}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.permissionKeys.map((key) => (
              <tr key={key}>
                <td style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{key}</td>
                {data.roles.map((r) => (
                  <td
                    key={r.id}
                    className="matrix-cell"
                    onClick={() => !saving && toggle(r.id, key, r.permissions[key])}
                  >
                    {cellLabel(r.permissions[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
