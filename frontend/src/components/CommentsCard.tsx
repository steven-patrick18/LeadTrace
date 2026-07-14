import { FormEvent, useEffect, useState } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';

interface Comment {
  id: number;
  body: string;
  createdAt: string;
  user: { id: number; name: string; role: { displayName: string } };
}

/**
 * Lead comments — writable by the Manager, the Admin, and the people who
 * worked this lead (server-enforced). Read-only for everyone else with view
 * access. Keeps working after CLOSED_WON: post-sale discussion stays with the
 * Closer.
 */
export function CommentsCard({ leadId }: { leadId: number }) {
  const { can } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setComments(await get<Comment[]>(`/leads/${leadId}/comments`));
    } catch {
      /* no view access */
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [leadId]);

  if (!can('comment_lead')) return null;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setError('');
    try {
      await post(`/leads/${leadId}/comments`, { body });
      setBody('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comment failed');
    }
  };

  return (
    <div className="card">
      <h2>Comments</h2>
      <form onSubmit={add} className="row" style={{ marginBottom: 12 }}>
        <input
          style={{ flex: 1 }}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment (manager, admin, and this lead's team)…"
        />
        <button type="submit" disabled={!body.trim()}>Comment</button>
      </form>
      {error && <div className="error">{error}</div>}
      {comments.length === 0 && <p className="muted">No comments yet.</p>}
      {comments.map((c) => (
        <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(42,53,80,0.5)' }}>
          <div style={{ fontSize: '0.9rem' }}>{c.body}</div>
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 2 }}>
            {c.user.name} ({c.user.role.displayName}) · {new Date(c.createdAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
