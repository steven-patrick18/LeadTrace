import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';

interface LeadRow {
  id: number;
  firstName: string;
  lastName: string;
  primaryPhone: string;
  city: string | null;
  state: string | null;
  currentTier: string;
  status: string;
  updatedAt: string;
  assignedTo: { id: number; name: string } | null;
  createdBy: { id: number; name: string };
}

export function MyLeads() {
  const { can } = useAuth();
  const [items, setItems] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [tier, setTier] = useState('');
  const [q, setQ] = useState('');
  const [scopeAll, setScopeAll] = useState(false);

  const load = async () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (tier) params.set('tier', tier);
    if (q) params.set('q', q);
    params.set('page', String(page));
    if (can('view_all_leads') && scopeAll) params.set('scope', 'all');
    else params.set('scope', 'own');
    const r = await get<{ total: number; items: LeadRow[] }>(`/leads?${params}`);
    setItems(r.items);
    setTotal(r.total);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, tier, scopeAll]);

  return (
    <div>
      <h1>{scopeAll ? 'All Leads' : 'My Leads'}</h1>
      <div className="card">
        <div className="row">
          <div className="field">
            <label>Search</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="name, city, phone…" />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All</option>
              {['NEW', 'PENDING_ROUTING', 'IN_PROGRESS', 'QUALIFIED', 'CLOSED_WON', 'CLOSED_LOST', 'INVALID'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Tier</label>
            <select value={tier} onChange={(e) => { setPage(1); setTier(e.target.value); }}>
              <option value="">All</option>
              <option value="AGENT">Agent</option>
              <option value="SR_AGENT">Sr Agent</option>
              <option value="CLOSER">Closer</option>
            </select>
          </div>
          <button className="ghost" onClick={load}>Apply</button>
          {can('view_all_leads') && (
            <button className="ghost" onClick={() => { setPage(1); setScopeAll(!scopeAll); }}>
              {scopeAll ? 'Show mine only' : 'Show all leads'}
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Lead</th><th>Phone</th><th>Location</th><th>Tier</th><th>Status</th><th>Assigned</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id}>
                <td><Link to={`/leads/${l.id}`}>#{l.id} {l.firstName} {l.lastName}</Link></td>
                <td>{l.primaryPhone}</td>
                <td className="muted">{l.city ? `${l.city}, ${l.state}` : '—'}</td>
                <td><span className="badge tier">{l.currentTier}</span></td>
                <td><span className={`badge ${l.status}`}>{l.status}</span></td>
                <td className="muted">{l.assignedTo?.name ?? '—'}</td>
                <td className="muted">{new Date(l.updatedAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} className="muted">No leads found.</td></tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
          <span className="muted">{total} total</span>
          <span>
            <button className="ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>{' '}
            <button className="ghost sm" disabled={page * 25 >= total} onClick={() => setPage(page + 1)}>Next ›</button>
          </span>
        </div>
      </div>
    </div>
  );
}
