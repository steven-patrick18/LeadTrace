import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, post } from '../api';
import { useAuth } from '../auth';

interface Match {
  firstName: string;
  lastName: string;
  phones: Array<{ number: string; lineType: string; isPrimary: boolean }>;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ageRange: string | null;
  relatives: string[];
  confidence: number;
  sourceProvider: string;
}

interface SearchResult {
  matches: Match[];
  cacheHit: boolean;
  provider: string;
}

export function SearchPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [zip, setZip] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dupWarning, setDupWarning] = useState<{ match: Match; duplicates: Array<{ leadId: number; name: string; phone: string; status: string }> } | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await post<SearchResult>('/search', { phone, firstName, lastName, zip }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const addLead = async (m: Match, force = false) => {
    try {
      const lead = await post<{ id: number }>('/leads', {
        firstName: m.firstName,
        lastName: m.lastName,
        phones: m.phones,
        address: m.address ?? undefined,
        city: m.city ?? undefined,
        state: m.state ?? undefined,
        zip: m.zip ?? undefined,
        sourceProvider: m.sourceProvider,
        rawProviderData: m,
        force,
      });
      setDupWarning(null);
      nav(`/leads/${lead.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { duplicates: Array<{ leadId: number; name: string; phone: string; status: string }> };
        setDupWarning({ match: m, duplicates: body.duplicates });
      } else {
        setError(err instanceof Error ? err.message : 'Could not create lead');
      }
    }
  };

  const confClass = (c: number) => (c >= 70 ? 'conf-high' : c >= 40 ? 'conf-mid' : 'conf-low');

  return (
    <div>
      <h1>Person Search</h1>
      <div className="card">
        <form onSubmit={search} className="row">
          <div className="field">
            <label>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(305) 555-0100" />
          </div>
          <div className="field">
            <label>First name</label>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="field">
            <label>Last name</label>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div className="field">
            <label>ZIP</label>
            <input value={zip} onChange={(e) => setZip(e.target.value)} style={{ width: 90 }} />
          </div>
          <button type="submit" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
        {result && (
          <div className="muted" style={{ marginTop: 10 }}>
            {result.matches.length} match(es) via {result.provider}
            {result.cacheHit && ' · served from cache (no provider cost)'}
          </div>
        )}
      </div>

      {result?.matches.map((m, i) => (
        <div className="card" key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <strong style={{ fontSize: '1.05rem' }}>
                {m.firstName} {m.lastName}
              </strong>{' '}
              <span className={`confidence ${confClass(m.confidence)}`} title="Match confidence">
                {m.confidence}%
              </span>
              {m.ageRange && <span className="muted"> · age {m.ageRange}</span>}
              <div className="muted" style={{ marginTop: 6 }}>
                {m.address && `${m.address}, `}
                {m.city}, {m.state} {m.zip}
              </div>
              <div style={{ marginTop: 6 }}>
                {m.phones.map((p) => (
                  <span key={p.number} style={{ marginRight: 14 }}>
                    📞 {p.number} <span className="muted">({p.lineType}{p.isPrimary ? ', primary' : ''})</span>
                  </span>
                ))}
              </div>
              {m.relatives.length > 0 && (
                <div className="muted" style={{ marginTop: 6 }}>Relatives: {m.relatives.join(', ')}</div>
              )}
            </div>
            {can('create_lead') && <button onClick={() => addLead(m)}>+ Add to Leads</button>}
          </div>
        </div>
      ))}

      {dupWarning && (
        <div className="modal-back" onClick={() => setDupWarning(null)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()}>
            <h2>⚠️ Possible duplicate</h2>
            <p className="muted">A lead already exists with this phone number:</p>
            <table>
              <thead>
                <tr><th>Lead</th><th>Phone</th><th>Status</th></tr>
              </thead>
              <tbody>
                {dupWarning.duplicates.map((d) => (
                  <tr key={d.leadId}>
                    <td><a href={`/leads/${d.leadId}`}>#{d.leadId} {d.name}</a></td>
                    <td>{d.phone}</td>
                    <td><span className={`badge ${d.status}`}>{d.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => setDupWarning(null)}>Cancel</button>
              <button className="warn" onClick={() => addLead(dupWarning.match, true)}>Create anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
