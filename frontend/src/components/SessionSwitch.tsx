import { FormEvent, useEffect, useState } from 'react';
import { batchInfo, endBatchMode, get, inBatchMode, post, startBatchMode } from '../api';

interface MySession {
  id: number;
  startedAt: string;
  expiresAt: string;
  onScreenOf: { id: number; name: string };
}

/**
 * The Session switch. Scenario: the call is live on this machine under the
 * Agent's login; the Sr Agent / Closer / Manager walks over, clicks Session,
 * types THEIR batch ID and works as themselves — no logout. The session
 * auto-ends after the admin-set duration and this screen returns to the
 * original login. Owners see sessions running under their identity anywhere
 * and can revoke them.
 */
export function SessionSwitch() {
  const active = inBatchMode() ? batchInfo() : null;
  return active ? <BatchBanner expiresAt={active.expiresAt} name={active.user.name} /> : <SessionMenu />;
}

function BatchBanner({ expiresAt, name }: { expiresAt: string; name: string }) {
  const [left, setLeft] = useState(Math.max(0, new Date(expiresAt).getTime() - Date.now()));

  useEffect(() => {
    const t = window.setInterval(async () => {
      const remaining = new Date(expiresAt).getTime() - Date.now();
      if (remaining <= 0) {
        window.clearInterval(t);
        await endBatchMode(); // auto-logout → restore the original login
        window.location.reload();
        return;
      }
      setLeft(remaining);
    }, 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);

  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);

  const endNow = async () => {
    await endBatchMode();
    window.location.reload();
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: '#4d3b10', border: '1px solid var(--amber)', borderRadius: 20,
        padding: '4px 14px', fontSize: '0.82rem',
      }}
    >
      <span>
        ⚡ Working as <strong>{name}</strong> · {mm}:{String(ss).padStart(2, '0')} left
      </span>
      <button className="ghost sm" onClick={endNow}>End session</button>
    </div>
  );
}

function SessionMenu() {
  const [open, setOpen] = useState(false);
  const [myBatchId, setMyBatchId] = useState<string | null>(null);
  const [showMyId, setShowMyId] = useState(false);
  const [code, setCode] = useState('');
  const [mine, setMine] = useState<MySession[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setMyBatchId((await get<{ batchId: string | null }>('/users/my-batch-id')).batchId);
      setMine(await get<MySession[]>('/auth/batch-sessions/mine'));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line
  }, [open]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await post<{ accessToken: string; expiresAt: string; user: never }>(
        '/auth/batch-session',
        { batchId: code },
      );
      startBatchMode(data);
      window.location.reload(); // re-mount the app as the new identity
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    await post(`/auth/batch-sessions/${id}/revoke`);
    await load();
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="ghost sm" onClick={() => setOpen(!open)} title="Quick session switch">
        ⚡ Session{mine.length > 0 ? ` (${mine.length})` : ''}
      </button>
      {open && (
        <div
          className="card"
          style={{ position: 'absolute', right: 0, top: 38, width: 360, zIndex: 60, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}
        >
          <h2 style={{ fontSize: '0.95rem' }}>Quick session</h2>
          <p className="muted" style={{ fontSize: '0.78rem' }}>
            Taking over this screen mid-call? Type <strong>your</strong> batch ID to work as yourself.
            The session ends automatically and this screen returns to the current login.
          </p>
          <form onSubmit={start} className="row" style={{ marginBottom: 12 }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Your batch ID (e.g. LT-CARL)"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={busy || code.trim().length < 4}>Start</button>
          </form>
          {error && <div className="error">{error}</div>}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: '0.8rem' }}>
            <div style={{ marginBottom: 8 }}>
              <span className="muted">My batch ID: </span>
              {showMyId ? (
                <code>{myBatchId ?? '—'}</code>
              ) : (
                <a href="#" onClick={(e) => { e.preventDefault(); setShowMyId(true); }}>show</a>
              )}
            </div>
            <div className="muted" style={{ marginBottom: 6 }}>Active sessions under my identity:</div>
            {mine.length === 0 && <div className="muted">None.</div>}
            {mine.map((s) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                <span>
                  On <strong>{s.onScreenOf.name}</strong>'s screen · until{' '}
                  {new Date(s.expiresAt).toLocaleTimeString()}
                </span>
                <button className="danger sm" onClick={() => revoke(s.id)}>Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
