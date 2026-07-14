import { useEffect, useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';

interface Provider {
  id: number;
  code: string;
  displayName: string;
  isActive: boolean;
  costPerSearchCents: number;
  dailySpendCapCents: number;
  cacheTtlHours: number;
  permittedUseAttestation: string | null;
}

export function SettingsPage() {
  const { can } = useAuth();
  return (
    <div>
      <h1>Settings</h1>
      {can('manage_providers') && <Providers />}
      {can('manage_permissions') && <AppSettings />}
      {can('system_lockdown') && <Lockdown />}
    </div>
  );
}

function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState('');

  const load = async () => setProviders(await get<Provider[]>('/providers'));
  useEffect(() => { load(); }, []);

  const update = async (id: number, data: Partial<Provider>) => {
    setError('');
    try {
      await patch(`/providers/${id}`, data);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="card">
      <h2>Data providers</h2>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Provider data is licensed for <strong>sales lead-generation only</strong>. Never use it for credit,
        employment, insurance, or tenant-screening decisions (FCRA / DPPA / GLBA restricted). Activating a
        provider requires a recorded permitted-use attestation.
      </p>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr><th>Provider</th><th>Active</th><th>Cost/search</th><th>Daily cap</th><th>Cache TTL</th><th></th></tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.displayName} <span className="muted">({p.code})</span></td>
              <td>{p.isActive ? <span className="badge CLOSED_WON">ACTIVE</span> : <span className="badge INVALID">off</span>}</td>
              <td>${(p.costPerSearchCents / 100).toFixed(2)}</td>
              <td>{p.dailySpendCapCents ? `$${(p.dailySpendCapCents / 100).toFixed(2)}` : '—'}</td>
              <td>{p.cacheTtlHours}h</td>
              <td>
                {!p.isActive && (
                  <button className="sm" onClick={() => update(p.id, { isActive: true })}>Activate</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AppSettings() {
  const [threshold, setThreshold] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    get<Record<string, string>>('/settings').then((s) => setThreshold(s.routing_aging_threshold_minutes ?? '60'));
  }, []);

  const save = async () => {
    await patch('/settings', { routingAgingThresholdMinutes: Number(threshold) });
    setMsg('Saved.');
    setTimeout(() => setMsg(''), 2500);
  };

  return (
    <div className="card">
      <h2>Routing safeguards</h2>
      <div className="row">
        <div className="field">
          <label>Aging alert after (minutes in queue)</label>
          <input type="number" min={5} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 120 }} />
        </div>
        <button onClick={save}>Save</button>
        {msg && <span className="ok">{msg}</span>}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Queue rows pending longer than this flag every user holding <code>route_leads</code>. Tip: grant{' '}
        <code>route_leads</code> to a second user as a backup admin.
      </p>
    </div>
  );
}

function Lockdown() {
  const [hasKey, setHasKey] = useState(false);
  const [freshKey, setFreshKey] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = async () => {
    const s = await get<{ hasActiveRecoveryKey: boolean }>('/lockdown/status');
    setHasKey(s.hasActiveRecoveryKey);
  };
  useEffect(() => { load(); }, []);

  const generate = async () => {
    setError('');
    const r = await post<{ recoveryKey: string }>('/lockdown/recovery-key');
    setFreshKey(r.recoveryKey);
    await load();
  };

  const trigger = async () => {
    setError('');
    try {
      await post('/lockdown/trigger', { confirmed: true });
      // After this call succeeds the whole system (including us) goes dark.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <h2 style={{ color: 'var(--red)' }}>🚨 Break-glass lockdown</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Lockdown blacks out the <strong>entire system for everyone — including you</strong>. Browsers will show a
        connection failure. The only way back in is the secret wake URL plus the recovery key below. Keep the key
        on paper, off this machine.
      </p>

      {freshKey ? (
        <>
          <p className="ok">Recovery key generated — this is the ONLY time it will be shown. Write it down now.</p>
          <div className="keybox">{freshKey}</div>
          <button className="ghost sm" onClick={() => setFreshKey('')}>I have written it down</button>
        </>
      ) : (
        <p>
          Recovery key: {hasKey ? <span className="ok">active ✓</span> : <span className="error">none — lockdown disabled</span>}{' '}
          <button className="ghost sm" onClick={generate} style={{ marginLeft: 10 }}>
            {hasKey ? 'Regenerate (kills old key)' : 'Generate recovery key'}
          </button>
        </p>
      )}

      {error && <div className="error">{error}</div>}

      {!confirming ? (
        <button className="danger" disabled={!hasKey} onClick={() => setConfirming(true)} style={{ marginTop: 10 }}>
          LOCKDOWN SYSTEM
        </button>
      ) : (
        <div style={{ marginTop: 10 }}>
          <p className="error">
            <strong>Final warning:</strong> this blacks out the ENTIRE system including your own session. Only the
            paper recovery key at the wake URL can restore access. Proceed?
          </p>
          <div className="row">
            <button className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger" onClick={trigger}>Yes — lock everything down now</button>
          </div>
        </div>
      )}
    </div>
  );
}
