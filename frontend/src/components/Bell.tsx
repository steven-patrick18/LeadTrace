import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

interface Notif {
  id: number;
  title: string;
  body: string | null;
  leadId: number | null;
  isRead: boolean;
  createdAt: string;
}

export function Bell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const timer = useRef<number>();

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
    timer.current = window.setInterval(poll, 30000);
    return () => window.clearInterval(timer.current);
  }, []);

  const toggle = async () => {
    if (!open) setItems(await get<Notif[]>('/notifications'));
    setOpen(!open);
  };

  const markAll = async () => {
    await post('/notifications/read-all');
    setCount(0);
    setItems(items.map((i) => ({ ...i, isRead: true })));
  };

  return (
    <>
      <button className="bell" onClick={toggle} title="Notifications">
        🔔{count > 0 && <span className="dot">{count}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between' }}>
            <strong>Notifications</strong>
            <a href="#" onClick={(e) => { e.preventDefault(); markAll(); }}>
              Mark all read
            </a>
          </div>
          {items.length === 0 && <div className="notif-item muted">Nothing yet.</div>}
          {items.map((n) => (
            <div key={n.id} className={`notif-item${n.isRead ? '' : ' unread'}`}>
              {n.leadId ? (
                <Link to={`/leads/${n.leadId}`} onClick={() => setOpen(false)}>
                  {n.title}
                </Link>
              ) : (
                n.title
              )}
              <div className="when muted">{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
