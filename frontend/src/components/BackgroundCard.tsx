import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';

interface Report {
  id: number;
  purpose: string;
  createdAt: string;
  runBy: { id: number; name: string };
  data: {
    identity: { name: string; dob: string | null };
    criminalRecords: Array<Record<string, string>>;
    vehicles: Array<Record<string, string>>;
    civil: { bankruptcies: number; liens: number; judgments: number };
  };
}

/**
 * Regulated-data panel (FCRA/DPPA). Renders only when the module is enabled AND
 * the viewer holds view_regulated_data. Running a report needs
 * run_background_report and a stated permissible purpose. Everything is audited.
 */
export function BackgroundCard({ leadId }: { leadId: number }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<{ enabled: boolean; purposes: string[] } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!can('view_regulated_data')) return;
    get<{ enabled: boolean; purposes: string[] }>('/regulated-data/status')
      .then((s) => {
        setStatus(s);
        setPurpose(s.purposes[0] ?? '');
      })
      .catch(() => setStatus({ enabled: false, purposes: [] }));
    get<Report>(`/leads/${leadId}/background-report`).then(setReport).catch(() => setReport(null));
  }, [leadId, can]);

  if (!can('view_regulated_data') || !status?.enabled) return null;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await post<Report>(`/leads/${leadId}/background-report`, { purpose }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const d = report?.data;
  return (
    <div className="card" style={{ borderColor: 'var(--amber)' }}>
      <h2>⚖️ Background &amp; Compliance (regulated)</h2>
      <div style={{ background: '#4d3b1033', border: '1px solid var(--amber)', borderRadius: 8, padding: '8px 12px', fontSize: '0.82rem', marginBottom: 12 }}>
        FCRA/DPPA-regulated data. Only run with a lawful permissible purpose — every pull is logged with your name,
        the lead, and the purpose. Not for sales/marketing use.
      </div>

      {can('run_background_report') && (
        <div className="row" style={{ alignItems: 'flex-end', gap: 10, marginBottom: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Permissible purpose (required, recorded)</label>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {status.purposes.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <button className="warn" onClick={run} disabled={busy || !purpose}>
            {busy ? 'Running…' : report ? 'Re-run report' : 'Run background report'}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {report && d && (
        <div style={{ fontSize: '0.88rem' }}>
          <div className="muted" style={{ fontSize: '0.76rem', marginBottom: 8 }}>
            Run by {report.runBy.name} · {new Date(report.createdAt).toLocaleString()} · purpose: <em>{report.purpose}</em>
          </div>

          <h3 style={{ fontSize: '0.9rem', margin: '10px 0 4px' }}>Criminal records ({d.criminalRecords.length})</h3>
          {d.criminalRecords.length === 0 ? (
            <div className="muted">None found.</div>
          ) : (
            d.criminalRecords.map((c, i) => (
              <div key={i} style={{ background: 'var(--panel2)', borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                <strong>{c.offense || 'Offense'}</strong>{c.caseType && <span className="muted"> · {c.caseType}</span>}
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {[c.agency, c.county && `${c.county} County`, c.state].filter(Boolean).join(' · ')}
                  {c.status && ` · ${c.status}`}{c.disposition && ` · ${c.disposition}`}
                  {c.arrestDate && ` · arrest ${c.arrestDate}`}
                </div>
              </div>
            ))
          )}

          <h3 style={{ fontSize: '0.9rem', margin: '12px 0 4px' }}>Vehicles ({d.vehicles.length})</h3>
          {d.vehicles.length === 0 ? (
            <div className="muted">None found.</div>
          ) : (
            d.vehicles.map((v, i) => (
              <div key={i} className="muted" style={{ padding: '2px 0' }}>
                🚗 {[v.year, v.color, v.make, v.model].filter(Boolean).join(' ')} {v.vin && <span style={{ fontFamily: 'monospace' }}>· {v.vin}</span>}
              </div>
            ))
          )}

          <div className="muted" style={{ marginTop: 10 }}>
            Civil: {d.civil.bankruptcies} bankruptcies · {d.civil.liens} liens · {d.civil.judgments} judgments
          </div>
        </div>
      )}
    </div>
  );
}
