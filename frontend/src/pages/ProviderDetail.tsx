import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch } from '../api';

interface ProviderFull {
  id: number;
  code: string;
  displayName: string;
  description: string | null;
  isActive: boolean;
  implemented: boolean;
  costPerSearchCents: number;
  dailySpendCapCents: number;
  dailyRequestLimit: number;
  cacheTtlHours: number;
  runOnSearch: boolean;
  enrichLevel: number;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  hasApiSecret: boolean;
  websiteUrl: string | null;
  signupUrl: string | null;
  docsUrl: string | null;
  baseUrl: string | null;
  howToGet: string | null;
  permittedUseAttestation: string | null;
  attestedAt: string | null;
  usage: {
    callsToday: number;
    spentTodayCents: number;
    last30d: { liveCalls: number; cacheHits: number; costCents: number; cacheHitRate: number };
  };
}

const DEFAULT_ATTESTATION =
  'We attest that data from this provider is used exclusively for sales lead generation. It will never be used for credit, employment, insurance, or tenant-screening decisions or any other FCRA/DPPA/GLBA-restricted purpose.';

/** One provider's own management page: signup process, credentials, costs,
 *  API access limits with live usage against them, and activation. */
export function ProviderDetail() {
  const { id } = useParams();
  const [p, setP] = useState<ProviderFull | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // editable state
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [cost, setCost] = useState('');
  const [cap, setCap] = useState('');
  const [reqLimit, setReqLimit] = useState('');
  const [ttl, setTtl] = useState('');
  const [attestation, setAttestation] = useState('');
  const [howToGet, setHowToGet] = useState('');
  const [editSteps, setEditSteps] = useState(false);

  const load = async () => {
    const data = await get<ProviderFull>(`/providers/${id}`);
    setP(data);
    setCost(String(data.costPerSearchCents));
    setCap(String(data.dailySpendCapCents));
    setReqLimit(String(data.dailyRequestLimit));
    setTtl(String(data.cacheTtlHours));
    setAttestation(data.permittedUseAttestation ?? '');
    setHowToGet(data.howToGet ?? '');
  };
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : 'Failed')); /* eslint-disable-next-line */ }, [id]);

  if (error && !p) return <div className="error">{error}</div>;
  if (!p) return <div className="muted">Loading…</div>;

  const flash = (m: string) => { setMsg(m); setError(''); setTimeout(() => setMsg(''), 3500); };
  const update = async (data: Record<string, unknown>, okMsg: string) => {
    try {
      await patch(`/providers/${p.id}`, data);
      await load();
      flash(okMsg);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setMsg('');
    }
  };

  const saveCredentials = (e: FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {};
    if (apiKey.trim()) data.apiKey = apiKey.trim();
    if (apiSecret.trim()) data.apiSecret = apiSecret.trim();
    if (!Object.keys(data).length) return;
    update(data, 'Credentials saved — stored server-side only, never sent back to the browser.');
    setApiKey('');
    setApiSecret('');
  };

  const limitPct = p.dailyRequestLimit > 0 ? Math.min(100, Math.round((p.usage.callsToday / p.dailyRequestLimit) * 100)) : 0;

  return (
    <div>
      <p><Link to="/providers">← All providers</Link></p>
      <h1>
        {p.displayName} <span className="muted" style={{ fontSize: '0.9rem' }}>({p.code})</span>{' '}
        {p.isActive && <span className="badge CLOSED_WON">ACTIVE</span>}{' '}
        {p.implemented
          ? <span className="badge tier">adapter ready</span>
          : <span className="badge PENDING_ROUTING">adapter pending</span>}
      </h1>
      {p.description && <p className="muted" style={{ maxWidth: 760 }}>{p.description}</p>}
      <p style={{ fontSize: '0.86rem' }}>
        {p.websiteUrl && <a href={p.websiteUrl} target="_blank" rel="noreferrer" style={{ marginRight: 16 }}>Website ↗</a>}
        {p.signupUrl && <a href={p.signupUrl} target="_blank" rel="noreferrer" style={{ marginRight: 16 }}>Sign up ↗</a>}
        {p.docsUrl && <a href={p.docsUrl} target="_blank" rel="noreferrer">API docs ↗</a>}
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      {/* Live usage vs limits */}
      <div className="grid cols4">
        <div className="card stat">
          <div className="num" style={{ color: limitPct >= 90 ? 'var(--red)' : limitPct >= 70 ? 'var(--amber)' : undefined }}>
            {p.usage.callsToday}{p.dailyRequestLimit > 0 ? ` / ${p.dailyRequestLimit}` : ''}
          </div>
          <div className="lbl">API calls today{p.dailyRequestLimit > 0 ? ` (${limitPct}% of limit)` : ' (no limit set)'}</div>
        </div>
        <div className="card stat">
          <div className="num">${(p.usage.spentTodayCents / 100).toFixed(2)}{p.dailySpendCapCents > 0 ? ` / $${(p.dailySpendCapCents / 100).toFixed(0)}` : ''}</div>
          <div className="lbl">Spend today{p.dailySpendCapCents > 0 ? ' (vs cap)' : ''}</div>
        </div>
        <div className="card stat"><div className="num">{p.usage.last30d.cacheHitRate}%</div><div className="lbl">Cache hit rate (30d)</div></div>
        <div className="card stat"><div className="num">${(p.usage.last30d.costCents / 100).toFixed(2)}</div><div className="lbl">Cost last 30 days ({p.usage.last30d.liveCalls} live calls)</div></div>
      </div>

      <div className="grid cols2">
        {/* Sign-up process */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h2>How to get access</h2>
            <button className="ghost sm" onClick={() => setEditSteps(!editSteps)}>{editSteps ? 'Cancel' : '✎ Edit steps'}</button>
          </div>
          {editSteps ? (
            <>
              <textarea rows={8} style={{ width: '100%' }} value={howToGet} onChange={(e) => setHowToGet(e.target.value)} />
              <button style={{ marginTop: 8 }} onClick={() => { update({ howToGet }, 'Steps saved.'); setEditSteps(false); }}>Save steps</button>
            </>
          ) : (
            <div style={{ whiteSpace: 'pre-line', fontSize: '0.88rem', lineHeight: 1.65 }}>
              {p.howToGet || <span className="muted">No instructions recorded yet — click "Edit steps".</span>}
            </div>
          )}
        </div>

        {/* Credentials */}
        <div className="card">
          <h2>API credentials</h2>
          {['MOCK', 'LEADTRACE_ENGINE'].includes(p.code) ? (
            <p className="muted">This built-in provider needs no credentials — it runs on your own server.</p>
          ) : (
            <>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                {p.hasApiKey
                  ? <>Key on file: <code>••••{p.apiKeyLast4}</code>{p.hasApiSecret && ' · secret on file'} — enter a new value to replace.</>
                  : 'No credentials saved yet.'}{' '}
                Keys are stored server-side and never returned to the browser.
              </p>
              <form onSubmit={saveCredentials}>
                <div className="field" style={{ marginBottom: 10 }}>
                  <label>API key</label>
                  <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={p.hasApiKey ? 'replace…' : 'paste key'} />
                </div>
                <div className="field" style={{ marginBottom: 10 }}>
                  <label>API secret (if the provider uses one)</label>
                  <input type="password" autoComplete="off" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder={p.hasApiSecret ? 'replace…' : 'optional'} />
                </div>
                <button type="submit" disabled={!apiKey.trim() && !apiSecret.trim()}>Save credentials</button>
              </form>
            </>
          )}
        </div>
      </div>

      {/* Limits & costs */}
      <div className="card">
        <h2>API access limits &amp; costs</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field">
            <label>Daily API request limit (0 = unlimited)</label>
            <input type="number" min={0} value={reqLimit} onChange={(e) => setReqLimit(e.target.value)} style={{ width: 140 }} />
          </div>
          <div className="field">
            <label>Daily spend cap (cents, 0 = none)</label>
            <input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 140 }} />
          </div>
          <div className="field">
            <label>Cost per search (cents)</label>
            <input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: 120 }} />
          </div>
          <div className="field">
            <label>Cache TTL (hours)</label>
            <input type="number" min={1} value={ttl} onChange={(e) => setTtl(e.target.value)} style={{ width: 110 }} />
          </div>
          <button onClick={() => update({
            dailyRequestLimit: Number(reqLimit) || 0,
            dailySpendCapCents: Number(cap) || 0,
            costPerSearchCents: Number(cost) || 0,
            cacheTtlHours: Math.max(1, Number(ttl) || 720),
          }, 'Limits saved — enforced on the next API call.')}>Save limits</button>
        </div>
        <p className="muted" style={{ fontSize: '0.78rem' }}>
          When the request limit or spend cap is hit, live calls to this provider stop until midnight — cached
          results keep working. Both breaches are audited.
        </p>

        <h2 style={{ marginTop: 18 }}>Cost tiering — search vs enrich</h2>
        <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
          <div className="field">
            <label>Runs on…</label>
            <select value={p.runOnSearch ? 'search' : 'enrich'} onChange={(e) => update({ runOnSearch: e.target.value === 'search' }, 'Stage saved.')}>
              <option value="search">Search + Enrich</option>
              <option value="enrich">Enrich only (skip on search)</option>
            </select>
          </div>
          <div className="field">
            <label>Enrich depth level</label>
            <select value={p.enrichLevel} onChange={(e) => update({ enrichLevel: Number(e.target.value) }, 'Enrich level saved.')}>
              <option value={1}>Level 1 — basic (all users)</option>
              <option value={2}>Level 2 — standard</option>
              <option value={3}>Level 3 — deep / most expensive</option>
            </select>
          </div>
        </div>
        <p className="muted" style={{ fontSize: '0.78rem' }}>
          Put cheap providers on <strong>Search + Enrich</strong> so every agent lookup returns name + latest address.
          Set expensive providers to <strong>Enrich only</strong> so you pay for depth only after a number becomes a
          lead. A provider at level N runs at enrich only for users whose enrich level is ≥ N (set on the Users page).
        </p>
      </div>

      {/* Attestation + activation */}
      <div className="card">
        <h2>Permitted-use attestation &amp; activation</h2>
        <textarea rows={3} style={{ width: '100%', maxWidth: 760 }} value={attestation} onChange={(e) => setAttestation(e.target.value)} placeholder={DEFAULT_ATTESTATION} />
        {!attestation && (
          <div><button className="ghost sm" style={{ marginTop: 6 }} onClick={() => setAttestation(DEFAULT_ATTESTATION)}>Use standard wording</button></div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          {attestation.trim().length >= 20 && attestation !== p.permittedUseAttestation && (
            <button onClick={() => update({ permittedUseAttestation: attestation.trim() }, 'Attestation recorded (audited with your name).')}>Record attestation</button>
          )}
          {p.isActive ? (
            <button className="warn" onClick={() => update({ isActive: false }, 'Deactivated — activate another provider before searching.')}>Deactivate</button>
          ) : (
            <button className="success" onClick={() => update({ isActive: true }, `${p.displayName} is now the active provider.`)}>Activate this provider</button>
          )}
        </div>
        {p.attestedAt && <p className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>Attestation recorded {new Date(p.attestedAt).toLocaleString()}.</p>}
      </div>
    </div>
  );
}
