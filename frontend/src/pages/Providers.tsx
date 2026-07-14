import { FormEvent, useEffect, useState } from 'react';
import { get, patch, post } from '../api';

interface Provider {
  id: number;
  code: string;
  displayName: string;
  description: string | null;
  isActive: boolean;
  implemented: boolean;
  costPerSearchCents: number;
  dailySpendCapCents: number;
  cacheTtlHours: number;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  hasApiSecret: boolean;
  websiteUrl: string | null;
  signupUrl: string | null;
  docsUrl: string | null;
  howToGet: string | null;
  permittedUseAttestation: string | null;
}

const DEFAULT_ATTESTATION =
  'We attest that data from this provider is used exclusively for sales lead generation. It will never be used for credit, employment, insurance, or tenant-screening decisions or any other FCRA/DPPA/GLBA-restricted purpose.';

export function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = async () => setProviders(await get<Provider[]>('/providers'));
  useEffect(() => { load(); }, []);

  const flash = (text: string) => {
    setMsg(text);
    setError('');
    setTimeout(() => setMsg(''), 3500);
  };
  const fail = (err: unknown) => {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMsg('');
  };

  return (
    <div>
      <h1>Data Providers</h1>
      <p className="muted" style={{ maxWidth: 780 }}>
        Exactly <strong>one provider is active</strong> at a time — it serves every person search. Every search is
        cache-first, so repeated queries never hit the provider again until the cache TTL expires. Compliance:
        provider data is licensed for <strong>sales lead-generation only</strong> — never credit, employment,
        insurance, or tenant-screening decisions (FCRA / DPPA / GLBA). Activation requires saved credentials and a
        recorded permitted-use attestation.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      {providers.map((p) => (
        <ProviderCard key={p.id} p={p} onChanged={load} onOk={flash} onErr={fail} />
      ))}

      <div className="card">
        {!showNew ? (
          <button className="ghost" onClick={() => setShowNew(true)}>+ Add a custom provider</button>
        ) : (
          <NewProviderForm
            onDone={() => { setShowNew(false); load(); flash('Provider added to the catalog.'); }}
            onCancel={() => setShowNew(false)}
            onErr={fail}
          />
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  p, onChanged, onOk, onErr,
}: {
  p: Provider;
  onChanged: () => Promise<void>;
  onOk: (m: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [cost, setCost] = useState(String(p.costPerSearchCents));
  const [cap, setCap] = useState(String(p.dailySpendCapCents));
  const [ttl, setTtl] = useState(String(p.cacheTtlHours));
  const [attestation, setAttestation] = useState(p.permittedUseAttestation ?? '');

  const update = async (data: Record<string, unknown>, okMsg: string) => {
    try {
      await patch(`/providers/${p.id}`, data);
      await onChanged();
      onOk(okMsg);
    } catch (err) {
      onErr(err);
    }
  };

  const saveCredentials = () => {
    const data: Record<string, unknown> = {};
    if (apiKey.trim()) data.apiKey = apiKey.trim();
    if (apiSecret.trim()) data.apiSecret = apiSecret.trim();
    if (!Object.keys(data).length) return;
    update(data, 'Credentials saved (stored server-side only — they are never sent back to the browser).');
    setApiKey('');
    setApiSecret('');
  };

  const saveConfig = () =>
    update(
      {
        costPerSearchCents: Number(cost) || 0,
        dailySpendCapCents: Number(cap) || 0,
        cacheTtlHours: Math.max(1, Number(ttl) || 720),
        ...(attestation.trim().length >= 20 && attestation !== p.permittedUseAttestation
          ? { permittedUseAttestation: attestation.trim() }
          : {}),
      },
      'Settings saved.',
    );

  return (
    <div className="card" style={p.isActive ? { borderColor: 'var(--green)' } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <strong style={{ fontSize: '1.06rem' }}>{p.displayName}</strong>{' '}
          <span className="muted">({p.code})</span>{' '}
          {p.isActive && <span className="badge CLOSED_WON">ACTIVE</span>}{' '}
          {p.implemented
            ? <span className="badge tier">adapter ready</span>
            : <span className="badge PENDING_ROUTING" title="Credentials can be saved now; searches need the adapter coded first.">adapter pending</span>}
          {p.description && <div className="muted" style={{ marginTop: 6, maxWidth: 640 }}>{p.description}</div>}
          <div style={{ marginTop: 6, fontSize: '0.84rem' }}>
            {p.websiteUrl && <a href={p.websiteUrl} target="_blank" rel="noreferrer" style={{ marginRight: 14 }}>Website ↗</a>}
            {p.signupUrl && <a href={p.signupUrl} target="_blank" rel="noreferrer" style={{ marginRight: 14 }}>Sign up ↗</a>}
            {p.docsUrl && <a href={p.docsUrl} target="_blank" rel="noreferrer">API docs ↗</a>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="ghost sm" onClick={() => setOpen(!open)}>{open ? 'Hide setup' : 'Setup'}</button>
          {p.isActive ? (
            p.code !== 'MOCK' || true ? (
              <button className="warn sm" onClick={() => update({ isActive: false }, `${p.displayName} deactivated. Activate another provider before searching.`)}>
                Deactivate
              </button>
            ) : null
          ) : (
            <button className="sm" onClick={() => update({ isActive: true }, `${p.displayName} is now the active provider.`)}>
              Activate
            </button>
          )}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {p.howToGet && (
            <>
              <h2>How to get access</h2>
              <div style={{ whiteSpace: 'pre-line', fontSize: '0.88rem', lineHeight: 1.65, marginBottom: 16 }}>
                {p.howToGet}
              </div>
            </>
          )}

          {p.code !== 'MOCK' && (
            <>
              <h2>API credentials</h2>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                {p.hasApiKey
                  ? <>Key on file: <code>••••{p.apiKeyLast4}</code>{p.hasApiSecret && ', secret on file'} — enter a new value to replace.</>
                  : 'No credentials saved yet.'}{' '}
                Keys are stored server-side and never returned to the browser.
              </p>
              <div className="row" style={{ marginBottom: 16 }}>
                <div className="field">
                  <label>API key {p.code === 'ENDATO' && '(AP Name)'}</label>
                  <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={p.hasApiKey ? 'replace…' : 'paste key'} style={{ width: 240 }} />
                </div>
                <div className="field">
                  <label>API secret {p.code === 'ENDATO' && '(AP Password)'} <span className="muted">(if the provider uses one)</span></label>
                  <input type="password" autoComplete="off" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder={p.hasApiSecret ? 'replace…' : 'optional'} style={{ width: 240 }} />
                </div>
                <button onClick={saveCredentials} disabled={!apiKey.trim() && !apiSecret.trim()}>Save credentials</button>
              </div>
            </>
          )}

          <h2>Cost &amp; cache</h2>
          <div className="row" style={{ marginBottom: 16 }}>
            <div className="field">
              <label>Cost per search (cents)</label>
              <input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: 120 }} />
            </div>
            <div className="field">
              <label>Daily spend cap (cents, 0 = none)</label>
              <input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 140 }} />
            </div>
            <div className="field">
              <label>Cache TTL (hours)</label>
              <input type="number" min={1} value={ttl} onChange={(e) => setTtl(e.target.value)} style={{ width: 110 }} />
            </div>
          </div>

          <h2>Permitted-use attestation</h2>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Required before activation. Recorded with your name and timestamp in the audit log.
          </p>
          <textarea
            rows={3}
            style={{ width: '100%', maxWidth: 700 }}
            value={attestation}
            onChange={(e) => setAttestation(e.target.value)}
            placeholder={DEFAULT_ATTESTATION}
          />
          {!attestation && (
            <div>
              <button className="ghost sm" style={{ marginTop: 6 }} onClick={() => setAttestation(DEFAULT_ATTESTATION)}>
                Use standard wording
              </button>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <button onClick={saveConfig}>Save settings</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewProviderForm({
  onDone, onCancel, onErr,
}: {
  onDone: () => void;
  onCancel: () => void;
  onErr: (e: unknown) => void;
}) {
  const [form, setForm] = useState({ code: '', displayName: '', description: '', websiteUrl: '', signupUrl: '', docsUrl: '', howToGet: '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post('/providers', {
        ...form,
        code: form.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        description: form.description || undefined,
        websiteUrl: form.websiteUrl || undefined,
        signupUrl: form.signupUrl || undefined,
        docsUrl: form.docsUrl || undefined,
        howToGet: form.howToGet || undefined,
      });
      onDone();
    } catch (err) {
      onErr(err);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Add a custom provider</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="field"><label>Code (UPPER_SNAKE)</label><input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="MY_PROVIDER" style={{ width: 160 }} /></div>
        <div className="field"><label>Display name</label><input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} style={{ width: 220 }} /></div>
        <div className="field"><label>Website URL</label><input value={form.websiteUrl} onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} placeholder="https://…" style={{ width: 220 }} /></div>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="field"><label>Sign-up URL</label><input value={form.signupUrl} onChange={(e) => setForm({ ...form, signupUrl: e.target.value })} placeholder="https://…" style={{ width: 260 }} /></div>
        <div className="field"><label>API docs URL</label><input value={form.docsUrl} onChange={(e) => setForm({ ...form, docsUrl: e.target.value })} placeholder="https://…" style={{ width: 260 }} /></div>
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>Description</label>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ width: '100%', maxWidth: 560 }} />
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>How to get access (steps shown to admins)</label>
        <textarea rows={4} value={form.howToGet} onChange={(e) => setForm({ ...form, howToGet: e.target.value })} style={{ width: '100%', maxWidth: 700 }} placeholder={'1. Sign up at …\n2. Generate an API key in …\n3. Paste it here and Save credentials.'} />
      </div>
      <div className="row">
        <button type="submit">Add provider</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
      <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
        New providers start inactive. Activation needs saved credentials, an attestation, and a coded adapter
        (see <code>backend/src/providers/</code>).
      </p>
    </form>
  );
}
