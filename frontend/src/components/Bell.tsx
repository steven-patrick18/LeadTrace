import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../api';

interface Notif {
  id: number;
  type: string;
  title: string;
  body: string | null;
  leadId: number | null;
  isRead: boolean;
  createdAt: string;
}

/**
 * Notifications bell. Rules:
 *  - a notification stays UNREAD (bold, counted) until the person clicks it;
 *  - clicking marks that one read and jumps straight to the concerned lead.
 * Lead changes, comments, status changes and closes notify the assignee,
 * the creator, and every oversight user (manager/admin) — never the actor.
 */
export function Bell() {
  const nav = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const poll = async () => {
    try {
      const r = await get<{ count: number }>('/notifications/unread-count');
      setCount(r.count);
    } catch {
      /* logged out or locked down */
    }
  };

  useEffect(() => {
    poll();
    const t = window.setInterval(poll, 30000);
    return () => window.clearInterval(t);
  }, []);

  // Close when clicking anywhere outside the panel
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = async () => {
    if (!open) {
      try {
        setItems(await get<Notif[]>('/notifications'));
      } catch {
        setItems([]);
      }
    }
    setOpen(!open);
  };

  const openNotification = async (n: Notif) => {
    if (!n.isRead) {
      try {
        await post(`/notifications/${n.id}/read`);
      } catch {
        /* non-fatal */
      }
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setCount((c) => Math.max(0, c - 1));
    }
    if (n.leadId) {
      setOpen(false);
      nav(`/leads/${n.leadId}`);
    }
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button className="bell" onClick={toggle} title="Notifications" aria-label="Notifications">
        🔔{count > 0 && <span className="dot">{count}</span>}
      </button>
      {open && (
        <div className="notif-panel" style={{ right: 0, top: 40 }}>
          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
            <strong>Notifications {count > 0 && <span className="muted">({count} unread)</span>}</strong>
          </div>
          {items.length === 0 && <div className="notif-item muted">Nothing yet.</div>}
          {items.map((n) => (
            <div
              key={n.id}
              className={`notif-item${n.isRead ? '' : ' unread'}`}
              style={{ cursor: n.leadId ? 'pointer' : 'default' }}
              title={n.leadId ? 'Open the lead' : undefined}
              onClick={() => openNotification(n)}
            >
              <div style={{ fontWeight: n.isRead ? 400 : 700 }}>
                {n.title} {n.leadId && <span className="muted">→</span>}
              </div>
              {n.body && <div className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>{n.body}</div>}
              <div className="when muted">{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
