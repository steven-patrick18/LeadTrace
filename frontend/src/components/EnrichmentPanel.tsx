import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';

interface Enrichment {
  leadId: number;
  status: string;
  enrichedAt: string;
  enrichmentCost: number;
  providerData: {
    aliases: string[];
    addresses: Array<{ line1: string; city: string; state: string; zip: string; type: string; since?: string }>;
    phones: Array<{ number: string; lineType: string; carrier?: string; active: boolean; spamRisk: string; isPrimary: boolean }>;
    emails: string[];
    ageRange: string | null;
    relatives: Array<{ name: string; relation?: string }>;
    associates: Array<{ name: string }>;
    property: { ownership: string; estValue?: number; type?: string };
    socialUrls: string[];
    providerConfidence: number;
    sourceProvider: string;
  } | null;
  geoData: {
    timezone: string | null;
    localTimeNow: string | null;
    areaCodeRegion: string | null;
    addressValid: boolean;
    censusAreaStats?: { medianIncomeBand: string; note: string };
  } | null;
  complianceData: {
    nationalDncStatus: string;
    stateDncStatus: string;
    internalDncStatus: string;
    litigatorFlag: boolean;
    callable: boolean;
  } | null;
  intelligence: {
    dataCompletenessPct: number;
    leadScore: number;
    conversionProbability: number;
    conversionProbabilityMethod: string;
    bestTimeToCall: string;
    duplicateFlag: boolean;
    routingHint?: { name: string; reason: string };
    scoreBreakdown: Array<{ key: string; points: number; reason: string }>;
  } | null;
}

export function EnrichmentPanel({ leadId, onCallableChange }: { leadId: number; onCallableChange?: (callable: boolean) => void }) {
  const { can } = useAuth();
  const [data, setData] = useState<Enrichment | null>(null);
  const [notYet, setNotYet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showBreakdown, setShowBreakdown] = useState(false);

  const load = async () => {
    try {
      const d = await get<Enrichment>(`/leads/${leadId}/enrichment`);
      setData(d);
      setNotYet(false);
      onCallableChange?.(d.complianceData?.callable !== false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotYet(true);
      else setError(err instanceof Error ? err.message : 'Failed to load enrichment');
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [leadId]);

  const enrich = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await post<Enrichment>(`/leads/${leadId}/enrich`);
      setData(d);
      setNotYet(false);
      onCallableChange?.(d.complianceData?.callable !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setBusy(false);
    }
  };

  if (!can('view_enrichment')) return null;

  const scoreColor = (s: number) => (s >= 70 ? 'var(--green)' : s >= 40 ? 'var(--amber)' : 'var(--red)');
  const i = data?.intelligence;
  const c = data?.complianceData;
  const p = data?.providerData;
  const g = data?.geoData;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Enrichment</h2>
        {can('enrich_lead') && (
          <button onClick={enrich} disabled={busy}>
            {busy ? 'Enriching…' : data ? '↻ Re-enrich' : '✨ Enrich'}
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {notYet && !data && (
        <p className="muted" style={{ marginTop: 10 }}>
          Not enriched yet. Enrich to pull provider data, validate the phone, run the DNC scrub, and compute the
          lead score. Re-runs within the cache window are free.
        </p>
      )}

      {data && (
        <>
          {/* DNC / compliance banner — the visible calling gate */}
          {c && !c.callable ? (
            <div style={{ background: '#4d1512', border: '1px solid var(--red)', borderRadius: 8, padding: '10px 14px', margin: '12px 0' }}>
              <strong style={{ color: '#ff8a80' }}>⛔ DO NOT CALL — calling this lead is blocked.</strong>
              <div style={{ fontSize: '0.84rem', marginTop: 4, color: '#ffb4ad' }}>
                {c.litigatorFlag && <div>• Flagged on a TCPA litigator list</div>}
                {c.nationalDncStatus === 'on_list' && <div>• National DNC registry (no recorded consent)</div>}
                {c.stateDncStatus === 'on_list' && <div>• State DNC registry (no recorded consent)</div>}
                {c.internalDncStatus === 'on_list' && <div>• Internal opt-out list</div>}
                <div style={{ marginTop: 4 }}>Call attempts are refused by the server and logged.</div>
              </div>
            </div>
          ) : c ? (
            <div style={{ background: '#0f4d2a33', border: '1px solid var(--green)', borderRadius: 8, padding: '8px 14px', margin: '12px 0', fontSize: '0.86rem' }}>
              ✅ Clear to call — no DNC or litigator flags.
            </div>
          ) : null}

          {/* Score row */}
          {i && (
            <div className="grid cols4" style={{ margin: '12px 0' }}>
              <div className="stat">
                <div className="num" style={{ color: scoreColor(i.leadScore), cursor: 'pointer' }} onClick={() => setShowBreakdown(!showBreakdown)} title="Click for score breakdown">
                  {i.leadScore}
                </div>
                <div className="lbl">Lead score ▾</div>
              </div>
              <div className="stat">
                <div className="num">{Math.round(i.conversionProbability * 100)}%</div>
                <div className="lbl">Conversion probability ({i.conversionProbabilityMethod})</div>
              </div>
              <div className="stat">
                <div className="num">{i.dataCompletenessPct}%</div>
                <div className="lbl">Data completeness</div>
              </div>
              <div className="stat">
                <div className="num" style={{ fontSize: '0.95rem', lineHeight: 1.4, paddingTop: 8 }}>{g?.localTimeNow ?? '—'}</div>
                <div className="lbl">Lead's local time</div>
              </div>
            </div>
          )}

          {showBreakdown && i && (
            <div style={{ background: 'var(--panel2)', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: '0.84rem' }}>
              <strong>Score breakdown</strong> <span className="muted">(reproducible from stored data + admin weights)</span>
              {i.scoreBreakdown.map((b, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                  <span>{b.reason}</span>
                  <span style={{ color: b.points >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                    {b.points >= 0 ? '+' : ''}{b.points}
                  </span>
                </div>
              ))}
            </div>
          )}

          {i && (
            <p style={{ fontSize: '0.88rem' }}>
              🕑 <strong>Best time to call:</strong> {i.bestTimeToCall}
              {i.duplicateFlag && <span className="wait-warn"> · ⚠ possible duplicate lead in system</span>}
              {i.routingHint && (
                <span className="muted"> · 💡 top converter: {i.routingHint.name} ({i.routingHint.reason})</span>
              )}
            </p>
          )}

          {/* Phone quality badges */}
          {p && p.phones.length > 0 && (
            <div style={{ margin: '10px 0' }}>
              {p.phones.map((ph) => (
                <div key={ph.number} style={{ fontSize: '0.88rem', padding: '3px 0' }}>
                  📞 {ph.number}{' '}
                  <span className={`badge ${ph.active ? 'CLOSED_WON' : 'CLOSED_LOST'}`}>{ph.active ? 'active' : 'inactive'}</span>{' '}
                  <span className="badge tier">{ph.lineType}</span>{' '}
                  {ph.carrier && <span className="muted">{ph.carrier}</span>}{' '}
                  <span className={`badge ${ph.spamRisk === 'low' ? 'CLOSED_WON' : ph.spamRisk === 'med' ? 'PENDING_ROUTING' : 'CLOSED_LOST'}`}>
                    spam risk: {ph.spamRisk}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Details grid */}
          {p && (
            <div style={{ fontSize: '0.86rem', lineHeight: 1.7 }}>
              {p.emails.length > 0 && <div>✉️ {p.emails.join(', ')}</div>}
              {p.ageRange && <div>🎂 Age range {p.ageRange}</div>}
              {p.property.ownership !== 'unknown' && (
                <div>
                  🏠 {p.property.ownership === 'own' ? 'Property owner' : 'Renter'}
                  {p.property.estValue && ` · est. $${p.property.estValue.toLocaleString()}`}
                </div>
              )}
              {p.addresses.map((a, idx) => (
                <div key={idx} className={a.type === 'past' ? 'muted' : ''}>
                  📍 {a.line1}, {a.city}, {a.state} {a.zip} {a.type === 'past' && `(past${a.since ? `, since ${a.since}` : ''})`}
                </div>
              ))}
              {p.relatives.length > 0 && (
                <div className="muted">👥 Relatives: {p.relatives.map((r) => r.relation ? `${r.name} (${r.relation})` : r.name).join(', ')}</div>
              )}
              {p.associates.length > 0 && <div className="muted">🤝 Associates: {p.associates.map((a) => a.name).join(', ')}</div>}
              {g?.areaCodeRegion && <div className="muted">☎️ Area code region: {g.areaCodeRegion}</div>}
              {g?.censusAreaStats && (
                <div className="muted" title={g.censusAreaStats.note}>
                  📊 ZIP-area median income band: {g.censusAreaStats.medianIncomeBand} <em>(area statistic, not personal data)</em>
                </div>
              )}
              {/* Social URLs: plain links only — displayed, never fetched (scope rule) */}
              {p.socialUrls.length > 0 && (
                <div>
                  🔗{' '}
                  {p.socialUrls.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noopener noreferrer" style={{ marginRight: 10 }}>
                      {new URL(u).hostname.replace('www.', '')} profile ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 12 }}>
            Status {data.status} · via {p?.sourceProvider ?? '—'} (confidence {(p ? Math.round(p.providerConfidence * 100) : 0)}%) ·
            enriched {new Date(data.enrichedAt).toLocaleString()} · run cost ${data.enrichmentCost.toFixed(2)}
          </div>
        </>
      )}
    </div>
  );
}
