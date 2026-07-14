import { useEffect, useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';

export function SettingsPage() {
  const { can } = useAuth();
  return (
    <div>
      <h1>Settings</h1>
      {can('manage_permissions') && <AppSettings />}
      {can('edit_score_weights') && <ScoreWeights />}
      {can('system_lockdown') && <Lockdown />}
    </div>
  );
}

const WEIGHT_LABELS: Record<string, string> = {
  phone_active_mobile: 'Phone is an active mobile',
  has_valid_email: 'Has at least one email',
  property_owner: 'Property owner',
  address_validated: 'Address validated',
  callable: 'Clear to call (no DNC flags)',
  data_completeness_max: 'Data completeness (max points)',
  not_callable_score_cap: 'Score cap when NOT callable',
};

function ScoreWeights() {
  const [rows, setRows] = useState<Array<{ id: number; key: string; weight: number }>>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => setRows(await get('/score-weights'));
  useEffect(() => { load(); }, []);

  const save = async (key: string) => {
    setMsg('');
    setError('');
    try {
      await patch('/score-weights', { key, weight: Number(edits[key]) });
      setMsg('Weight saved — new enrich runs use it immediately (re-enrich to rescore a lead).');
      setEdits((e) => ({ ...e, [key]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="card">
      <h2>Lead score weights</h2>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        The lead score is a transparent weighted sum — every enrichment stores its full breakdown, so scores
        stay reproducible and auditable after weight changes.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <table style={{ maxWidth: 640 }}>
        <thead>
          <tr><th>Signal</th><th>Points</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{WEIGHT_LABELS[r.key] ?? r.key} <span className="muted" style={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>({r.key})</span></td>
              <td>
                <input
                  type="number"
                  min={0}
                  style={{ width: 80 }}
                  value={edits[r.key] !== undefined && edits[r.key] !== '' ? edits[r.key] : r.weight}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [r.key]: e.target.value }))}
                />
              </td>
              <td>
                <button className="ghost sm" disabled={!edits[r.key] || Number(edits[r.key]) === r.weight} onClick={() => save(r.key)}>
                  Save
                </button>
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
