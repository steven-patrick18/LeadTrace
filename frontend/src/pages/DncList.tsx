import { FormEvent, useEffect, useState } from 'react';
import { api, get, post } from '../api';

interface DncRow {
  id: number;
  phone: string;
  reason: string;
  litigator: boolean;
  createdAt: string;
  addedBy: { id: number; name: string };
}

export function DncList() {
  const [rows, setRows] = useState<DncRow[]>([]);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [litigator, setLitigator] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => setRows(await get<DncRow[]>('/dnc'));
  useEffect(() => { load(); }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMsg('');
    try {
      await post('/dnc', { phone, reason, litigator });
      setPhone('');
      setReason('');
      setLitigator(false);
      setMsg('Added. This phone is now blocked from calling everywhere in the system.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const remove = async (row: DncRow) => {
    if (!confirm(`Remove ${row.phone} from the opt-out list? Calling it becomes allowed again.`)) return;
    setError('');
    try {
      await api('DELETE', `/dnc/${row.id}`);
      setMsg('Removed (logged in the audit trail).');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div>
      <h1>USA DNC &amp; Litigator List</h1>
      <p className="muted" style={{ maxWidth: 760 }}>
        This is the <strong>single authoritative source</strong> for call blocking. A phone is blocked
        <strong> only if it is on this list</strong> — nothing else marks a lead "do not call". Any number here is
        blocked from call logging immediately, everywhere, regardless of when the lead was last enriched.
        Add consumer opt-out requests and known TCPA litigators here the moment you learn of them.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <form onSubmit={add} className="row" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Phone</label>
            <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(305) 555-0100" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Reason</label>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder='e.g. "Asked to be removed on call 2026-07-14"' />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={litigator ? 'lit' : 'dnc'} onChange={(e) => setLitigator(e.target.value === 'lit')}>
              <option value="dnc">Do Not Call</option>
              <option value="lit">TCPA Litigator</option>
            </select>
          </div>
          <button type="submit">Add to list</button>
        </form>
        <table>
          <thead>
            <tr><th>Phone</th><th>Type</th><th>Reason</th><th>Added by</th><th>When</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontFamily: 'monospace' }}>{r.phone}</td>
                <td>
                  <span className={`badge ${r.litigator ? 'CLOSED_LOST' : 'PENDING_ROUTING'}`}>
                    {r.litigator ? '⚖️ Litigator' : 'Do Not Call'}
                  </span>
                </td>
                <td>{r.reason}</td>
                <td className="muted">{r.addedBy.name}</td>
                <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                <td><button className="ghost sm" onClick={() => remove(r)}>Remove</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">List is empty — no numbers are blocked.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
