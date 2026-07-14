import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';

interface Analysis {
  sinceDays: number;
  summary: {
    createdInPeriod: number;
    wonInPeriod: number;
    lostInPeriod: number;
    winRatePct: number;
    routingDecisions: number;
    avgRoutingMinutes: number;
    callsInPeriod: number;
  };
  funnel: { created: number; reachedSS: number; reachedCloser: number; won: number };
  byStatus: Record<string, number>;
  openByTier: Record<string, number>;
  perUser: Array<{
    user: { id: number; name: string; role: { displayName: string } };
    createdCount: number; activeAssigned: number; callsLogged: number;
    transfersRaised: number; leadsReceived: number; closedWon: number; closedLost: number;
  }>;
  activityByDay: Array<{ day: string; calls: number; other: number }>;
}

export function Reports() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [days, setDays] = useState(30);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Analysis | null>(null);

  const load = () => {
    const query = custom && from && to ? `from=${from}&to=${to}` : `days=${days}`;
    get<Analysis>(`/reports/analysis?${query}`).then(setData);
  };
  useEffect(() => {
    if (!custom) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, custom]);

  if (!data) return <div className="muted">Loading…</div>;

  const s = data.summary;
  const funnelMax = Math.max(1, data.funnel.created);
  const dayMax = Math.max(1, ...data.activityByDay.map((d) => d.calls + d.other));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>Reports &amp; Analysis</h1>
        <div className="row">
          <select
            value={custom ? 'custom' : days}
            onChange={(e) => {
              if (e.target.value === 'custom') setCustom(true);
              else {
                setCustom(false);
                setDays(Number(e.target.value));
              }
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
            <option value="custom">Custom range…</option>
          </select>
          {custom && (
            <>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="muted">to</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              <button disabled={!from || !to || from > to} onClick={load}>Apply</button>
            </>
          )}
          {can('export_data') && (
            <>
              <button className="ghost" onClick={() => downloadCsv('/reports/export/leads.csv', 'leads')}>⬇ Leads CSV</button>
              <button className="ghost" onClick={() => downloadCsv('/reports/export/performance.csv', 'performance')}>⬇ Performance CSV</button>
            </>
          )}
        </div>
      </div>

      <div className="grid cols4" style={{ marginTop: 16 }}>
        <Link to="/leads?scope=all" style={{ color: 'inherit' }}>
          <div className="card stat" style={{ cursor: 'pointer' }} title="See all leads">
            <div className="num">{s.createdInPeriod}</div><div className="lbl">Leads created →</div>
          </div>
        </Link>
        <div className="card stat"><div className="num">{s.callsInPeriod}</div><div className="lbl">Calls made</div></div>
        <Link to="/leads?scope=all&status=CLOSED_WON" style={{ color: 'inherit' }}>
          <div className="card stat" style={{ cursor: 'pointer' }} title="See won leads">
            <div className="num" style={{ color: 'var(--green)' }}>{s.wonInPeriod}</div>
            <div className="lbl">Won ({s.winRatePct}% win rate) →</div>
          </div>
        </Link>
        <div
          className="card stat"
          style={can('route_leads') ? { cursor: 'pointer' } : undefined}
          title={can('route_leads') ? 'Open the routing queue' : undefined}
          onClick={() => can('route_leads') && nav('/routing')}
        >
          <div className="num" style={{ color: s.avgRoutingMinutes > 60 ? 'var(--amber)' : undefined }}>{s.avgRoutingMinutes}m</div>
          <div className="lbl">Avg time to route ({s.routingDecisions} decisions){can('route_leads') ? ' →' : ''}</div>
        </div>
      </div>

      <div className="grid cols2">
        <div className="card">
          <h2>Conversion funnel (all time)</h2>
          {[
            { label: 'Created', value: data.funnel.created },
            { label: 'Reached Sr Agent', value: data.funnel.reachedSS },
            { label: 'Reached Closer', value: data.funnel.reachedCloser },
            { label: 'Won', value: data.funnel.won },
          ].map((step) => (
            <div key={step.label} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 3 }}>
                <span>{step.label}</span>
                <span className="muted">{step.value} ({Math.round((step.value / funnelMax) * 100)}%)</span>
              </div>
              <div style={{ background: 'var(--panel2)', borderRadius: 6, height: 14 }}>
                <div style={{ width: `${(step.value / funnelMax) * 100}%`, background: 'linear-gradient(90deg, var(--accent), var(--green))', height: '100%', borderRadius: 6 }} />
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Pipeline snapshot</h2>
          <table>
            <thead><tr><th>Status</th><th>Leads</th></tr></thead>
            <tbody>
              {Object.entries(data.byStatus).map(([status, n]) => (
                <tr
                  key={status}
                  style={{ cursor: 'pointer' }}
                  title="See these leads"
                  onClick={() => nav(`/leads?scope=all&status=${status}`)}
                >
                  <td><span className={`badge ${status}`}>{status}</span> <span className="muted">→</span></td>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
            Open leads by tier:{' '}
            {Object.entries(data.openByTier).map(([tier, n]) => (
              <Link key={tier} to={`/leads?scope=all&tier=${tier}`} style={{ marginRight: 10 }}>
                {tier} {n}
              </Link>
            ))}
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Activity volume by day</h2>
        {data.activityByDay.length === 0 && <span className="muted">No activity in this period.</span>}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, overflowX: 'auto', paddingBottom: 4 }}>
          {data.activityByDay.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.calls} calls, ${d.other} other`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 26, height: '100%' }}>
              <div style={{ height: `${(d.other / dayMax) * 100}%`, background: 'var(--panel2)', borderRadius: '3px 3px 0 0' }} />
              <div style={{ height: `${(d.calls / dayMax) * 100}%`, background: 'var(--accent)', borderRadius: d.other ? 0 : '3px 3px 0 0' }} />
              <div className="muted" style={{ fontSize: '0.58rem', textAlign: 'center', marginTop: 2 }}>{d.day.slice(5)}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: '0.75rem' }}>
          <span style={{ color: 'var(--accent)' }}>■</span> calls · <span>■</span> notes, status changes, other touches
        </p>
      </div>

      <div className="card">
        <h2>Per-user performance</h2>
        <table>
          <thead>
            <tr><th>User</th><th>Role</th><th>Created</th><th>Active</th><th>Calls</th><th>Transfers</th><th>Received</th><th>Won</th><th>Lost</th><th>Win rate</th></tr>
          </thead>
          <tbody>
            {data.perUser.map((p) => {
              const closed = p.closedWon + p.closedLost;
              return (
                <tr
                  key={p.user.id}
                  style={can('manage_users') ? { cursor: 'pointer' } : undefined}
                  title={can('manage_users') ? `Open ${p.user.name}'s page` : undefined}
                  onClick={() => can('manage_users') && nav(`/users/${p.user.id}`)}
                >
                  <td>{can('manage_users') ? <Link to={`/users/${p.user.id}`}>{p.user.name}</Link> : p.user.name}</td>
                  <td className="muted">{p.user.role.displayName}</td>
                  <td>{p.createdCount}</td>
                  <td>{p.activeAssigned}</td>
                  <td>{p.callsLogged}</td>
                  <td>{p.transfersRaised}</td>
                  <td>{p.leadsReceived}</td>
                  <td style={{ color: 'var(--green)' }}>{p.closedWon}</td>
                  <td style={{ color: 'var(--red)' }}>{p.closedLost}</td>
                  <td className="muted">{closed ? `${Math.round((p.closedWon / closed) * 100)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function downloadCsv(path: string, name: string) {
  const res = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('lt_access')}` },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leadtrace-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
