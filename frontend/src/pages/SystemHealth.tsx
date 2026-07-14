import { useEffect, useRef, useState } from 'react';
import { get, post } from '../api';

interface Health {
  commit: { hash: string; message: string; when: string };
  node: string;
  pid: number;
  uptime: { processSeconds: number; osSeconds: number };
  cpu: { cores: number; load1: number; load5: number; load15: number };
  memory: { totalMb: number; freeMb: number; usedPct: number; processRssMb: number };
  disk: { totalGb: number; freeGb: number; usedPct: number };
  latency: { dbMs: number; cacheMs: number };
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const pct = (p: number) => (p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--green)');
const ms = (v: number) => (v < 50 ? 'var(--green)' : v < 200 ? 'var(--amber)' : 'var(--red)');

export function SystemHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [ping, setPing] = useState<{ last: number; avg: number } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const samples = useRef<number[]>([]);
  const startCommit = useRef<string>('');

  const loadHealth = async () => {
    try {
      const data = await get<Health>('/system/health');
      setH(data);
      setError('');
      // Detect that an in-progress update has finished (commit changed)
      if (updating && startCommit.current && data.commit.hash !== startCommit.current && data.commit.hash !== 'unknown') {
        setUpdating(false);
        setUpdateMsg(`✅ Updated to ${data.commit.hash} — "${data.commit.message}"`);
      }
    } catch (err) {
      // During the restart window requests fail — that's expected mid-update
      if (!updating) setError(err instanceof Error ? err.message : 'Failed to load health');
    }
  };

  // Reaction-time probe: round-trip to a tiny endpoint every 2s
  const probe = async () => {
    const t0 = performance.now();
    try {
      await get('/system/ping');
      const rt = Math.round((performance.now() - t0) * 10) / 10;
      const arr = samples.current;
      arr.push(rt);
      if (arr.length > 15) arr.shift();
      setPing({ last: rt, avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 });
    } catch {
      /* ignore during restart */
    }
  };

  useEffect(() => {
    loadHealth();
    probe();
    const hi = window.setInterval(loadHealth, 5000);
    const pi = window.setInterval(probe, 2000);
    return () => {
      window.clearInterval(hi);
      window.clearInterval(pi);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating]);

  const runUpdate = async () => {
    if (!confirm('Pull the latest code from Git and redeploy? The app will briefly restart. Operators mid-action may need to retry once.')) return;
    setError('');
    setUpdateMsg('');
    startCommit.current = h?.commit.hash ?? '';
    try {
      const r = await post<{ started: boolean; message: string }>('/system/update');
      if (r.started) {
        setUpdating(true);
        setUpdateMsg('⏳ ' + r.message);
      } else {
        setError(r.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed to start');
    }
  };

  if (!h && !error) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>System &amp; Server</h1>
        <button className="success" onClick={runUpdate} disabled={updating}>
          {updating ? 'Updating…' : '⬇ Update from Git'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {updateMsg && <div className={updateMsg.startsWith('✅') ? 'ok' : 'muted'} style={{ margin: '8px 0' }}>{updateMsg}</div>}

      {h && (
        <>
          {/* Reaction time */}
          <div className="grid cols4" style={{ marginTop: 12 }}>
            <div className="card stat">
              <div className="num" style={{ color: ping ? ms(ping.last) : undefined }}>{ping ? `${ping.last}ms` : '—'}</div>
              <div className="lbl">Round-trip now (avg {ping?.avg ?? '—'}ms)</div>
            </div>
            <div className="card stat">
              <div className="num" style={{ color: ms(h.latency.dbMs) }}>{h.latency.dbMs}ms</div>
              <div className="lbl">Database response</div>
            </div>
            <div className="card stat">
              <div className="num" style={{ color: ms(h.latency.cacheMs) }}>{h.latency.cacheMs}ms</div>
              <div className="lbl">Cache response</div>
            </div>
            <div className="card stat">
              <div className="num">{fmtUptime(h.uptime.processSeconds)}</div>
              <div className="lbl">App uptime (server up {fmtUptime(h.uptime.osSeconds)})</div>
            </div>
          </div>

          {/* Resources */}
          <div className="grid cols3">
            <div className="card">
              <h2>CPU</h2>
              <div className="stat"><div className="num" style={{ color: pct((h.cpu.load1 / h.cpu.cores) * 100) }}>{h.cpu.load1}</div><div className="lbl">Load (1 min) across {h.cpu.cores} cores</div></div>
              <p className="muted" style={{ fontSize: '0.8rem', textAlign: 'center' }}>5 min: {h.cpu.load5} · 15 min: {h.cpu.load15}</p>
            </div>
            <div className="card">
              <h2>Memory</h2>
              <Bar label={`${(100 - h.memory.usedPct)}% free`} used={h.memory.usedPct} />
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                {Math.round((h.memory.totalMb - h.memory.freeMb) / 1000 * 10) / 10} / {Math.round(h.memory.totalMb / 1000 * 10) / 10} GB used ·
                app process {h.memory.processRssMb} MB
              </p>
            </div>
            <div className="card">
              <h2>Disk</h2>
              <Bar label={`${h.disk.freeGb} GB free`} used={h.disk.usedPct} />
              <p className="muted" style={{ fontSize: '0.8rem' }}>{Math.round((h.disk.totalGb - h.disk.freeGb) * 10) / 10} / {h.disk.totalGb} GB used</p>
            </div>
          </div>

          {/* Version */}
          <div className="card">
            <h2>Running version</h2>
            <p style={{ fontSize: '0.9rem' }}>
              Commit <code>{h.commit.hash}</code> — {h.commit.message || <span className="muted">(no message)</span>}
              {h.commit.when && <span className="muted"> · {new Date(h.commit.when).toLocaleString()}</span>}
            </p>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Node {h.node} · PID {h.pid}. The Update button pulls the latest committed code from GitHub, rebuilds,
              runs any new database migrations, and restarts the app — HTTPS and your data are untouched. Metrics
              refresh every 5s; reaction time probes every 2s.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Bar({ used, label }: { used: number; label: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: 4 }}>
        <span>{used}% used</span>
        <span className="muted">{label}</span>
      </div>
      <div style={{ background: 'var(--panel2)', borderRadius: 6, height: 16 }}>
        <div style={{ width: `${used}%`, height: '100%', borderRadius: 6, background: pct(used), transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}
