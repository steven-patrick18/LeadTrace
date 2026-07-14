import { FormEvent, useEffect, useState } from 'react';
import { api, get, post } from '../api';
import { useAuth } from '../auth';

interface AccessData {
  lead: { id: number; createdById: number; assignedToId: number | null };
  blocks: Array<{
    id: number;
    reason: string;
    createdAt: string;
    user: { id: number; name: string };
    blockedBy: { id: number; name: string };
  }>;
  users: Array<{ id: number; name: string; role: { displayName: string; roleCode: string } }>;
}

/** Admin-only: revoke/restore a specific person's access to this lead. */
export function LeadAccessCard({ leadId }: { leadId: number }) {
  const { can } = useAuth();
  const [data, setData] = useState<AccessData | null>(null);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => setData(await get<AccessData>(`/leads/${leadId}/access`));
  useEffect(() => {
    if (can('manage_lead_access')) load();
    // eslint-disable-next-line
  }, [leadId]);

  if (!can('manage_lead_access') || !data) return null;

  const block = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMsg('');
    try {
      await post(`/leads/${leadId}/access`, { userId: Number(userId), reason });
      setUserId('');
      setReason('');
      setMsg('Access revoked. The lead disappears from that user everywhere.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const unblock = async (targetId: number) => {
    setError('');
    setMsg('');
    try {
      await api('DELETE', `/leads/${leadId}/access/${targetId}`);
      setMsg('Access restored.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const blockedIds = new Set(data.blocks.map((b) => b.user.id));
  const candidates = data.users.filter((u) => !blockedIds.has(u.id) && u.role.roleCode !== 'ADMIN');

  return (
    <div className="card" style={{ borderColor: 'var(--amber)' }}>
      <h2>🔒 Lead access (admin)</h2>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Revoking access hides this lead from that person everywhere — lists, detail, edits, calls, comments.
        Admins cannot be blocked. Everything here is audited.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={block} className="row" style={{ marginBottom: 12 }}>
        <div className="field">
          <label>User</label>
          <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">— pick user —</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role.displayName})
                {u.id === data.lead.assignedToId ? ' — currently assigned' : u.id === data.lead.createdById ? ' — creator' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Reason</label>
          <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why access is being revoked" />
        </div>
        <button type="submit" className="warn">Revoke access</button>
      </form>

      {data.blocks.length > 0 && (
        <table>
          <thead>
            <tr><th>Blocked user</th><th>Reason</th><th>By</th><th>When</th><th></th></tr>
          </thead>
          <tbody>
            {data.blocks.map((b) => (
              <tr key={b.id}>
                <td>{b.user.name}</td>
                <td>{b.reason}</td>
                <td className="muted">{b.blockedBy.name}</td>
                <td className="muted">{new Date(b.createdAt).toLocaleDateString()}</td>
                <td><button className="ghost sm" onClick={() => unblock(b.user.id)}>Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
