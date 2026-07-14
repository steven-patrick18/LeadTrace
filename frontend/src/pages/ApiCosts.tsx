import { useEffect, useState } from 'react';
import { get } from '../api';

interface CostRow {
  provider: { code: string; displayName: string; isActive: boolean };
  liveCalls: number;
  cacheHits: number;
  cacheHitRate: number;
  totalCostCents: number;
  dailySpendCapCents: number;
}

export function ApiCosts() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<CostRow[]>([]);

  useEffect(() => {
    get<{ providers: CostRow[] }>(`/reports/api-costs?days=${days}`).then((r) => setRows(r.providers));
  }, [days]);

  return (
    <div>
      <h1>Provider Usage &amp; Costs</h1>
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label>Window</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Provider</th><th>Status</th><th>Live calls</th><th>Cache hits</th><th>Cache hit rate</th><th>Total cost</th><th>Daily cap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider.code}>
                <td>{r.provider.displayName}</td>
                <td>{r.provider.isActive ? <span className="badge CLOSED_WON">ACTIVE</span> : <span className="badge INVALID">off</span>}</td>
                <td>{r.liveCalls}</td>
                <td>{r.cacheHits}</td>
                <td>{r.cacheHitRate}%</td>
                <td>${(r.totalCostCents / 100).toFixed(2)}</td>
                <td className="muted">{r.dailySpendCapCents ? `$${(r.dailySpendCapCents / 100).toFixed(2)}` : 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: '0.78rem', marginTop: 10 }}>
          Every search is cache-first — cache hits cost $0. The cache hit rate is your money saved.
        </p>
      </div>
    </div>
  );
}
