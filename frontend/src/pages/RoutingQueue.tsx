import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

interface QueueRow {
  id: number;
  transferPoint: string;
  waitMinutes: number;
  createdAt: string;
  lead: { id: number; firstName: string; lastName: string; primaryPhone: string; city: string | null; state: string | null };
  raisedBy: { id: number; name: string; role: { displayName: string } };
}

interface Recipient {
  id: number;
  name: string;
  role: { roleCode: string; displayName: string };
  _count: { assignedLeads: number };
}

const GROUPS: Array<{ key: 'T1_TO_SS' | 'T2_TO_CLOSER' | 'T3_SEND_BACK'; title: string; hint: string }> = [
  { key: 'T1_TO_SS', title: 'T1 — Agent → Sr Agent', hint: 'pick which Sr Agent receives each lead' },
  { key: 'T2_TO_CLOSER', title: 'T2 — Sr Agent → Closer', hint: 'pick which Closer takes the final call' },
  { key: 'T3_SEND_BACK', title: 'T3 — Send-backs', hint: 'route back down to an Agent or Sr Agent' },
];

export function RoutingQueue() {
  const [queue, setQueue] = useState<Record<string, QueueRow[]>>({ T1_TO_SS: [], T2_TO_CLOSER: [], T3_SEND_BACK: [] });
  const [recipients, setRecipients] = useState<Record<string, Recipient[]>>({});
  const [selected, setSelected] = useState<Record<string, Set<number>>>({ T1_TO_SS: new Set(), T2_TO_CLOSER: new Set(), T3_SEND_BACK: new Set() });
  const [target, setTarget] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setQueue(await get('/routing/queue'));
    const recs: Record<string, Recipient[]> = {};
    for (const g of GROUPS) recs[g.key] = await get<Recipient[]>(`/routing/recipients?transferPoint=${g.key}`);
    setRecipients(recs);
  };
  useEffect(() => { load(); }, []);

  const toggle = (group: string, id: number) => {
    const next = new Set(selected[group]);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected({ ...selected, [group]: next });
  };

  const routeSelected = async (group: string) => {
    const ids = [...selected[group]];
    const toUserId = Number(target[group]);
    if (!ids.length || !toUserId) return;
    setMsg('');
    setError('');
    try {
      await post('/routing/queue/bulk-route', { queueIds: ids, toUserId });
      setMsg(`Routed ${ids.length} lead(s).`);
      setSelected({ ...selected, [group]: new Set() });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Routing failed');
    }
  };

  const routeOne = async (group: string, queueId: number) => {
    const toUserId = Number(target[group]);
    if (!toUserId) {
      setError('Pick a recipient first');
      return;
    }
    setMsg('');
    setError('');
    try {
      await post(`/routing/queue/${queueId}/route`, { toUserId });
      setMsg('Routed.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Routing failed');
    }
  };

  const totalPending = GROUPS.reduce((n, g) => n + (queue[g.key]?.length ?? 0), 0);

  return (
    <div>
      <h1>Routing Queue {totalPending > 0 && <span className="badge PENDING_ROUTING">{totalPending} pending</span>}</h1>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      {GROUPS.map((g) => {
        const rows = queue[g.key] ?? [];
        return (
          <div key={g.key}>
            <div className="qgroup-title">
              {g.title} <span className="count">{rows.length}</span>
              <span className="muted" style={{ fontWeight: 400 }}>— {g.hint}</span>
            </div>
            <div className="card">
              {rows.length === 0 ? (
                <span className="muted">Empty.</span>
              ) : (
                <>
                  <div className="row" style={{ marginBottom: 12 }}>
                    <div className="field">
                      <label>Route selected ({selected[g.key].size}) to</label>
                      <select value={target[g.key] ?? ''} onChange={(e) => setTarget({ ...target, [g.key]: e.target.value })}>
                        <option value="">— pick recipient —</option>
                        {(recipients[g.key] ?? []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} ({r.role.displayName}, {r._count.assignedLeads} active)
                          </option>
                        ))}
                      </select>
                    </div>
                    <button disabled={selected[g.key].size === 0 || !target[g.key]} onClick={() => routeSelected(g.key)}>
                      Bulk route {selected[g.key].size > 0 ? `(${selected[g.key].size})` : ''}
                    </button>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th></th><th>Lead</th><th>Phone</th><th>Location</th><th>Raised by</th><th>Waiting</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input type="checkbox" checked={selected[g.key].has(r.id)} onChange={() => toggle(g.key, r.id)} />
                          </td>
                          <td><Link to={`/leads/${r.lead.id}`}>#{r.lead.id} {r.lead.firstName} {r.lead.lastName}</Link></td>
                          <td>{r.lead.primaryPhone}</td>
                          <td className="muted">{r.lead.city ? `${r.lead.city}, ${r.lead.state}` : '—'}</td>
                          <td className="muted">{r.raisedBy.name} ({r.raisedBy.role.displayName})</td>
                          <td className={r.waitMinutes > 60 ? 'wait-warn' : ''}>
                            {r.waitMinutes < 60 ? `${r.waitMinutes}m` : `${Math.floor(r.waitMinutes / 60)}h ${r.waitMinutes % 60}m`}
                          </td>
                          <td>
                            <button className="sm" onClick={() => routeOne(g.key, r.id)}>Route</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
