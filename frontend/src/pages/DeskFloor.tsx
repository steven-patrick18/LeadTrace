import { FormEvent, useEffect, useState } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';

interface FloorData {
  desks: Array<{
    id: number;
    code: string;
    name: string;
    isActive: boolean;
    occupant: {
      sessionId: number;
      user: { id: number; name: string; role: { displayName: string } };
      since: string;
      minutes: number;
    } | null;
  }>;
  recentSessions: Array<{
    id: number;
    startedAt: string;
    endedAt: string | null;
    endReason: string | null;
    desk: { code: string };
    user: { id: number; name: string };
    endedBy: { id: number; name: string } | null;
    _count: { calls: number };
  }>;
}

export function DeskFloor() {
  const { scope } = useAuth();
  const readOnly = scope('manage_desks') === 'VIEW';
  const [data, setData] = useState<FloorData | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => setData(await get<FloorData>('/desks/floor'));
  useEffect(() => {
    load();
    const t = window.setInterval(load, 30000);
    return () => window.clearInterval(t);
  }, []);

  if (!data) return <div className="muted">Loading…</div>;

  const addDesk = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await post('/desks', { code: code.toUpperCase(), name });
      setCode('');
      setName('');
      setMsg('Desk added.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const force = async (sessionId: number, who: string) => {
    if (!confirm(`Force-complete ${who}'s desk session? They will be notified.`)) return;
    setError('');
    try {
      await post(`/desks/sessions/${sessionId}/force-complete`);
      setMsg('Session force-completed.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const endLabel: Record<string, string> = {
    CLOCK_OUT: 'clocked out',
    TAKEOVER: 'taken over',
    FORCED: 'force-completed',
  };

  return (
    <div>
      <h1>Desk Floor {readOnly && <span className="muted" style={{ fontSize: '0.8rem' }}>(view only)</span>}</h1>
      <p className="muted" style={{ maxWidth: 760 }}>
        Everyone signs in with their own account, then types the <strong>batch ID</strong> on their desk to clock
        in. If a Closer or Manager sits at an occupied seat and enters its batch ID, the previous session is
        closed as a takeover — every call is attributed to a person <em>and</em> a seat.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="grid cols3">
        {data.desks.map((d) => (
          <div className="card" key={d.id} style={{ borderColor: d.occupant ? 'var(--green)' : 'var(--border)', opacity: d.isActive ? 1 : 0.5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong style={{ fontSize: '1.05rem' }}>{d.code}</strong>
              <span className="muted" style={{ fontSize: '0.78rem' }}>{d.name}</span>
            </div>
            {d.occupant ? (
              <div style={{ marginTop: 8 }}>
                🪑 <strong>{d.occupant.user.name}</strong>{' '}
                <span className="badge tier">{d.occupant.user.role.displayName}</span>
                <div className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>
                  since {new Date(d.occupant.since).toLocaleTimeString()} ({d.occupant.minutes}m)
                </div>
                {!readOnly && (
                  <button className="warn sm" style={{ marginTop: 8 }} onClick={() => force(d.occupant!.sessionId, d.occupant!.user.name)}>
                    Force complete
                  </button>
                )}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 8 }}>— empty —</div>
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="card">
          <h2>Add a desk</h2>
          <form onSubmit={addDesk} className="row">
            <div className="field">
              <label>Batch ID</label>
              <input required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="DESK-07" style={{ width: 140 }} />
            </div>
            <div className="field">
              <label>Name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Seat 7" style={{ width: 180 }} />
            </div>
            <button type="submit">Add desk</button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Recent sessions</h2>
        <table>
          <thead>
            <tr><th>Desk</th><th>User</th><th>Started</th><th>Ended</th><th>How</th><th>Calls</th></tr>
          </thead>
          <tbody>
            {data.recentSessions.map((s) => (
              <tr key={s.id}>
                <td>{s.desk.code}</td>
                <td>{s.user.name}</td>
                <td className="muted">{new Date(s.startedAt).toLocaleString()}</td>
                <td className="muted">{s.endedAt ? new Date(s.endedAt).toLocaleTimeString() : <span className="badge CLOSED_WON">open</span>}</td>
                <td className="muted">
                  {s.endReason ? endLabel[s.endReason] ?? s.endReason : '—'}
                  {s.endedBy && s.endedBy.id !== s.user.id && ` by ${s.endedBy.name}`}
                </td>
                <td>{s._count.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
