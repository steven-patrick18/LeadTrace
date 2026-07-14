import { FormEvent, useEffect, useState } from 'react';
import { get, post } from '../api';

interface DeskMe {
  clockedIn: boolean;
  desk?: { code: string; name: string };
  since?: string;
}

/**
 * The batch-ID widget: everyone logs in with their own account, then types
 * the batch ID printed on their desk to clock in. Sitting at an occupied
 * seat takes it over (previous session force-completed + notified).
 */
export function DeskWidget() {
  const [me, setMe] = useState<DeskMe | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setMe(await get<DeskMe>('/desks/me'));
    } catch {
      /* not logged in yet */
    }
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60000); // reflect takeovers/forced ends
    return () => window.clearInterval(t);
  }, []);

  const clockIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/desks/clock-in', { batchCode: code });
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/desks/clock-out');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!me) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {me.clockedIn ? (
        <>
          <span
            style={{
              background: 'var(--panel2)', border: '1px solid var(--green)', borderRadius: 20,
              padding: '4px 12px', fontSize: '0.8rem',
            }}
            title={`Clocked in since ${me.since ? new Date(me.since).toLocaleTimeString() : ''}`}
          >
            🪑 <strong>{me.desk?.code}</strong> · on desk
          </span>
          <button className="ghost sm" onClick={clockOut} disabled={busy}>End shift</button>
        </>
      ) : (
        <form onSubmit={clockIn} style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="Clock in at a shared desk using its DESK-xx code (not your personal batch ID)">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Desk code (e.g. DESK-01)"
            style={{ width: 170, padding: '5px 9px', fontSize: '0.82rem' }}
          />
          <button type="submit" className="sm" disabled={busy || code.trim().length < 3}>Clock in</button>
        </form>
      )}
      {error && <span className="error" style={{ margin: 0, fontSize: '0.75rem' }}>{error}</span>}
    </div>
  );
}
