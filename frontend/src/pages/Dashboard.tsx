import { useEffect, useState } from 'react';
import { get } from '../api';
import { useAuth } from '../auth';

interface DashData {
  scope: string;
  byStatus: Record<string, number>;
  funnel: { created: number; reachedSS: number; reachedCloser: number; won: number };
  queue: { pending: number; avgWaitMinutes: number; maxWaitMinutes: number };
}

interface PerfRow {
  user: { id: number; name: string; role: { displayName: string } };
  createdCount: number;
  activeAssigned: number;
  callsLogged: number;
  transfersRaised: number;
  leadsReceived: number;
  closedWon: number;
  closedLost: number;
}

export function Dashboard() {
  const { can } = useAuth();
  const [data, setData] = useState<DashData | null>(null);
  const [perf, setPerf] = useState<PerfRow[]>([]);

  useEffect(() => {
    get<DashData>('/reports/dashboard').then(setData);
    get<PerfRow[]>('/reports/performance').then(setPerf);
  }, []);

  if (!data) return <div className="muted">Loading…</div>;

  const funnelSteps = [
    { label: 'Created', value: data.funnel.created },
    { label: 'Reached Sr Agent', value: data.funnel.reachedSS },
    { label: 'Reached Closer', value: data.funnel.reachedCloser },
    { label: 'Won', value: data.funnel.won },
  ];
  const max = Math.max(1, data.funnel.created);

  return (
    <div>
      <h1>
        Dashboard <span className="muted" style={{ fontSize: '0.85rem' }}>({data.scope === 'team' ? 'team-wide' : 'your activity'})</span>
      </h1>

      <div className="grid cols4">
        {['NEW', 'PENDING_ROUTING', 'IN_PROGRESS', 'CLOSED_WON'].map((s) => (
          <div className="card stat" key={s}>
            <div className="num">{data.byStatus[s] ?? 0}</div>
            <div className="lbl">{s.replace(/_/g, ' ')}</div>
          </div>
        ))}
      </div>

      <div className="grid cols2">
        <div className="card">
          <h2>Conversion funnel (Agent → SS → Closer → Won)</h2>
          {funnelSteps.map((s) => (
            <div key={s.label} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 3 }}>
                <span>{s.label}</span>
                <span className="muted">
                  {s.value} ({Math.round((s.value / max) * 100)}%)
                </span>
              </div>
              <div style={{ background: 'var(--panel2)', borderRadius: 6, height: 14 }}>
                <div
                  style={{
                    width: `${(s.value / max) * 100}%`,
                    background: 'linear-gradient(90deg, var(--accent), var(--green))',
                    height: '100%',
                    borderRadius: 6,
                    transition: 'width 0.4s',
                  }}
                />
              </div>
            </div>
          ))}
          <p className="muted" style={{ fontSize: '0.78rem' }}>
            Computed from the append-only routing history — every count is traceable to a routing decision.
          </p>
        </div>

        <div className="card">
          <h2>Routing queue health</h2>
          <div className="grid cols3">
            <div className="stat"><div className="num">{data.queue.pending}</div><div className="lbl">Pending</div></div>
            <div className="stat"><div className="num">{data.queue.avgWaitMinutes}m</div><div className="lbl">Avg wait</div></div>
            <div className="stat"><div className="num" style={{ color: data.queue.maxWaitMinutes > 60 ? 'var(--amber)' : undefined }}>{data.queue.maxWaitMinutes}m</div><div className="lbl">Max wait</div></div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{data.scope === 'team' ? 'Per-user performance' : 'Your performance'}</h2>
        <table>
          <thead>
            <tr>
              <th>User</th><th>Role</th><th>Created</th><th>Active</th><th>Calls</th><th>Transfers</th><th>Received</th><th>Won</th><th>Lost</th>
            </tr>
          </thead>
          <tbody>
            {perf.map((p) => (
              <tr key={p.user.id}>
                <td>{p.user.name}</td>
                <td className="muted">{p.user.role.displayName}</td>
                <td>{p.createdCount}</td>
                <td>{p.activeAssigned}</td>
                <td>{p.callsLogged}</td>
                <td>{p.transfersRaised}</td>
                <td>{p.leadsReceived}</td>
                <td style={{ color: 'var(--green)' }}>{p.closedWon}</td>
                <td style={{ color: 'var(--red)' }}>{p.closedLost}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {can('export_data') && (
          <p style={{ marginTop: 12 }}>
            <a href="/api/reports/export/leads.csv" onClick={(e) => { e.preventDefault(); downloadCsv(); }}>
              ⬇ Export all leads (CSV)
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

async function downloadCsv() {
  const res = await fetch('/api/reports/export/leads.csv', {
    headers: { Authorization: `Bearer ${localStorage.getItem('lt_access')}` },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leadtrace-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
