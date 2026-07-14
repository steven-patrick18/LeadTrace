import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  const nav = useNavigate();
  const [data, setData] = useState<DashData | null>(null);
  const [perf, setPerf] = useState<PerfRow[]>([]);

  useEffect(() => {
    get<DashData>('/reports/dashboard').then(setData);
    get<PerfRow[]>('/reports/performance').then(setPerf);
  }, []);

  if (!data) return <div className="muted">Loading…</div>;

  // Every number drills down to the leads list filtered to what it counts.
  const scope = can('view_all_leads') ? 'scope=all&' : '';
  const leadsUrl = (params: string) => `/leads?${scope}${params}`;

  const funnelSteps = [
    { label: 'Created', value: data.funnel.created, to: leadsUrl('') },
    { label: 'Reached Sr Agent', value: data.funnel.reachedSS, to: leadsUrl('tier=SR_AGENT') },
    { label: 'Reached Closer', value: data.funnel.reachedCloser, to: leadsUrl('tier=CLOSER') },
    { label: 'Won', value: data.funnel.won, to: leadsUrl('status=CLOSED_WON') },
  ];
  const max = Math.max(1, data.funnel.created);

  return (
    <div>
      <h1>
        Dashboard <span className="muted" style={{ fontSize: '0.85rem' }}>({data.scope === 'team' ? 'team-wide' : 'your activity'})</span>
      </h1>

      <div className="grid cols4">
        {['NEW', 'PENDING_ROUTING', 'IN_PROGRESS', 'CLOSED_WON'].map((s) => (
          <Link to={leadsUrl(`status=${s}`)} key={s} style={{ color: 'inherit' }}>
            <div className="card stat clickable" title={`See ${s.replace(/_/g, ' ').toLowerCase()} leads`}>
              <div className="num">{data.byStatus[s] ?? 0}</div>
              <div className="lbl">{s.replace(/_/g, ' ')} →</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid cols2">
        <div className="card">
          <h2>Conversion funnel (Agent → SS → Closer → Won)</h2>
          {funnelSteps.map((s) => (
            <div
              key={s.label}
              style={{ marginBottom: 10, cursor: 'pointer' }}
              title={`See these leads`}
              onClick={() => nav(s.to)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 3 }}>
                <span>{s.label} <span className="muted">→</span></span>
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
            Computed from the append-only routing history — click a bar to see those leads.
          </p>
        </div>

        <div
          className={`card${can('route_leads') ? ' clickable' : ''}`}
          style={can('route_leads') ? { cursor: 'pointer' } : undefined}
          onClick={() => can('route_leads') && nav('/routing')}
          title={can('route_leads') ? 'Open the routing queue' : undefined}
        >
          <h2>Routing queue health {can('route_leads') && <span className="muted" style={{ fontSize: '0.8rem' }}>→ open queue</span>}</h2>
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
              <tr
                key={p.user.id}
                style={can('manage_users') ? { cursor: 'pointer' } : undefined}
                title={can('manage_users') ? `Open ${p.user.name}'s page` : undefined}
                onClick={() => can('manage_users') && nav(`/users/${p.user.id}`)}
              >
                <td>{can('manage_users') ? <Link to={`/users/${p.user.id}`}>{p.user.name}</Link> : p.user.name}</td>
                <td className="muted">{p.user.role.displayName}</td>
                <td>{p.createdCount}</td>
                <td onClick={(e) => { e.stopPropagation(); if (can('view_all_leads')) nav(leadsUrl(`assignedTo=${p.user.id}&who=${encodeURIComponent(p.user.name)}`)); }}>
                  {p.activeAssigned}
                </td>
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
