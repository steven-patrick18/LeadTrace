import { useEffect, useState } from 'react';
import { api, get, patch, post } from '../api';
import { useAuth } from '../auth';

export function SettingsPage() {
  const { can } = useAuth();
  return (
    <div>
      <h1>Settings</h1>
      {can('manage_custom_fields') && <CustomFieldDefs />}
      {can('manage_custom_fields') && <TierStatusManager />}
      {can('manage_permissions') && <AppSettings />}
      {can('edit_score_weights') && <ScoreWeights />}
      {can('system_lockdown') && <Lockdown />}
    </div>
  );
}

interface FieldDef {
  id: number;
  label: string;
  fieldType: string;
  options: string[] | null;
  sortOrder: number;
  isActive: boolean;
}

function CustomFieldDefs() {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState('TEXT');
  const [options, setOptions] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => setFields(await get<FieldDef[]>('/custom-fields/all'));
  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMsg('');
    try {
      await post('/custom-fields', {
        label,
        fieldType,
        ...(fieldType === 'DROPDOWN'
          ? { options: options.split(',').map((o) => o.trim()).filter(Boolean) }
          : {}),
        sortOrder: fields.length,
      });
      setLabel('');
      setOptions('');
      setMsg('Field added — it now appears on every lead page.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const toggle = async (f: FieldDef) => {
    await patch(`/custom-fields/${f.id}`, { isActive: !f.isActive });
    await load();
  };

  return (
    <div className="card">
      <h2>Custom lead fields</h2>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Define the fields your process needs — they appear on every lead's page for the team to fill and keep
        updated as details are confirmed with the customer. Deactivating hides a field without deleting its data.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <form onSubmit={add} className="row" style={{ marginBottom: 14 }}>
        <div className="field">
          <label>Field name</label>
          <input required minLength={2} value={label} onChange={(e) => setLabel(e.target.value)} placeholder='e.g. "Policy interest", "Budget"' />
        </div>
        <div className="field">
          <label>Type</label>
          <select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            <option value="TEXT">Text</option>
            <option value="NUMBER">Number</option>
            <option value="DATE">Date</option>
            <option value="DROPDOWN">Dropdown</option>
          </select>
        </div>
        {fieldType === 'DROPDOWN' && (
          <div className="field" style={{ flex: 1 }}>
            <label>Options (comma-separated)</label>
            <input required value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Hot, Warm, Cold" />
          </div>
        )}
        <button type="submit">+ Add field</button>
      </form>
      <table style={{ maxWidth: 780 }}>
        <thead>
          <tr><th>Field</th><th>Type</th><th>Options</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.id}>
              <td>{f.label}</td>
              <td><span className="badge tier">{f.fieldType}</span></td>
              <td className="muted">{f.options?.join(', ') ?? '—'}</td>
              <td>{f.isActive ? <span className="badge CLOSED_WON">active</span> : <span className="badge INVALID">hidden</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="ghost sm" onClick={async () => {
                  const label = prompt('Rename field:', f.label);
                  if (label && label !== f.label) { await patch(`/custom-fields/${f.id}`, { label }); await load(); }
                }}>Rename</button>{' '}
                <button className="ghost sm" onClick={() => toggle(f)}>{f.isActive ? 'Deactivate' : 'Activate'}</button>{' '}
                <button className="danger sm" onClick={async () => {
                  if (!confirm(`Delete field "${f.label}"? Only possible while no lead has a value in it.`)) return;
                  try { await api('DELETE', `/custom-fields/${f.id}`); setMsg('Field deleted.'); await load(); }
                  catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
                }}>Delete</button>
              </td>
            </tr>
          ))}
          {fields.length === 0 && <tr><td colSpan={5} className="muted">No custom fields yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

interface TierStatusRow {
  id: number;
  tier: 'AGENT' | 'SR_AGENT' | 'CLOSER';
  label: string;
  isActive: boolean;
  _count: { leads: number };
}

/** Admin-owned per-tier work-status lists: add, rename, deactivate, delete. */
function TierStatusManager() {
  const [rows, setRows] = useState<TierStatusRow[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => setRows(await get<TierStatusRow[]>('/tier-statuses/all'));
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    setError(''); setMsg('');
    try { await fn(); setMsg(okMsg); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
  };

  const TIERS: Array<{ key: TierStatusRow['tier']; title: string }> = [
    { key: 'AGENT', title: 'Agent statuses' },
    { key: 'SR_AGENT', title: 'Sr Agent statuses' },
    { key: 'CLOSER', title: 'Closer statuses' },
  ];

  return (
    <div className="card">
      <h2>Work-status lists (per tier)</h2>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Each tier works from its own status list; the assigned user picks from the list of the lead's current
        tier. Statuses reset when a lead is routed to the next tier. Renames apply everywhere; delete only works
        while no lead uses the status (deactivate otherwise).
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <div className="grid cols3">
        {TIERS.map(({ key, title }) => (
          <div key={key}>
            <h2 style={{ fontSize: '0.9rem' }}>{title}</h2>
            {rows.filter((r) => r.tier === key).map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: '0.85rem', opacity: s.isActive ? 1 : 0.45 }}>
                <span style={{ flex: 1 }}>{s.label} {s._count.leads > 0 && <span className="muted">({s._count.leads})</span>}</span>
                <button className="ghost sm" title="Rename" onClick={() => {
                  const label = prompt('Rename status:', s.label);
                  if (label && label !== s.label) act(() => patch(`/tier-statuses/${s.id}`, { label }), 'Renamed.');
                }}>✎</button>
                <button className="ghost sm" title={s.isActive ? 'Deactivate' : 'Activate'} onClick={() => act(() => patch(`/tier-statuses/${s.id}`, { isActive: !s.isActive }), s.isActive ? 'Hidden.' : 'Restored.')}>
                  {s.isActive ? '◌' : '●'}
                </button>
                <button className="danger sm" title="Delete" onClick={() => {
                  if (confirm(`Delete "${s.label}"?`)) act(() => api('DELETE', `/tier-statuses/${s.id}`), 'Deleted.');
                }}>✕</button>
              </div>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <input
                placeholder="New status…"
                value={inputs[key] ?? ''}
                onChange={(e) => setInputs({ ...inputs, [key]: e.target.value })}
                style={{ flex: 1, fontSize: '0.82rem' }}
              />
              <button className="sm" disabled={!(inputs[key] ?? '').trim()} onClick={() => {
                act(() => post('/tier-statuses', { tier: key, label: inputs[key].trim() }), 'Added.');
                setInputs({ ...inputs, [key]: '' });
              }}>+ Add</button>
            </div>
          </div>
        ))}
      </div>
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
  const [batchMinutes, setBatchMinutes] = useState('');
  const [requireDesk, setRequireDesk] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    get<Record<string, string>>('/settings').then((s) => {
      setThreshold(s.routing_aging_threshold_minutes ?? '60');
      setBatchMinutes(s.batch_session_minutes ?? '30');
      setRequireDesk(s.require_desk_for_calls === 'true');
    });
  }, []);

  const save = async () => {
    await patch('/settings', {
      routingAgingThresholdMinutes: Number(threshold),
      batchSessionMinutes: Number(batchMinutes),
      requireDeskForCalls: requireDesk,
    });
    setMsg('Saved.');
    setTimeout(() => setMsg(''), 2500);
  };

  return (
    <div className="card">
      <h2>Operations settings</h2>
      <div className="row">
        <div className="field">
          <label>Aging alert after (minutes in queue)</label>
          <input type="number" min={5} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 120 }} />
        </div>
        <div className="field">
          <label>Quick-session duration (minutes)</label>
          <input type="number" min={5} max={480} value={batchMinutes} onChange={(e) => setBatchMinutes(e.target.value)} style={{ width: 120 }} />
        </div>
        <div className="field">
          <label>Desk clock-in required for calls</label>
          <select value={requireDesk ? 'yes' : 'no'} onChange={(e) => setRequireDesk(e.target.value === 'yes')}>
            <option value="no">No (recommended with quick sessions)</option>
            <option value="yes">Yes — strict desk discipline</option>
          </select>
        </div>
        <button onClick={save}>Save</button>
        {msg && <span className="ok">{msg}</span>}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Quick sessions (the ⚡ Session button) auto-log out after the duration above and return the screen to
        the original login. Aging alerts flag queue rows for every <code>route_leads</code> holder.
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
