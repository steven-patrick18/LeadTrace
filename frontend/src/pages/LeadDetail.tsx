import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { BackgroundCard } from '../components/BackgroundCard';
import { CommentsCard } from '../components/CommentsCard';
import { EnrichmentPanel } from '../components/EnrichmentPanel';
import { LeadAccessCard } from '../components/LeadAccessCard';
import { LeadInfoCard } from '../components/LeadInfoCard';

interface Lead {
  id: number;
  firstName: string;
  lastName: string;
  primaryPhone: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  currentTier: string;
  status: string;
  sourceProvider: string | null;
  createdAt: string;
  assignedTo: { id: number; name: string } | null;
  createdBy: { id: number; name: string };
  phones: Array<{ id: number; phone: string; lineType: string | null; isPrimary: boolean }>;
  activities: Array<{ id: number; type: string; detail: string; createdAt: string; user: { name: string } }>;
  queueEntries: Array<{ id: number; transferPoint: string }>;
  customValues: Array<{ fieldId: number; value: string }>;
  workStatus: { id: number; label: string } | null;
}

export function LeadDetail() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [noteType, setNoteType] = useState<'CALL' | 'NOTE'>('CALL');
  const [msg, setMsg] = useState('');
  const [callable, setCallable] = useState(true);

  const load = async () => {
    try {
      setLead(await get<Lead>(`/leads/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!lead) return <div className="muted">Loading…</div>;

  const isAssignedToMe = lead.assignedTo?.id === user?.id;
  const isOpen = !['CLOSED_WON', 'CLOSED_LOST'].includes(lead.status);
  const isPending = lead.status === 'PENDING_ROUTING';

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    setMsg('');
    setError('');
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { reasons?: string[] })?.reasons) {
        setError(`${err.message}: ${(err.body as { reasons: string[] }).reasons.join('; ')}`);
      } else {
        setError(err instanceof Error ? err.message : 'Action failed');
      }
    }
  };

  const logActivity = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    await act(() => post(`/leads/${lead.id}/activities`, { type: noteType, detail: note }), 'Logged.');
    setNote('');
  };

  return (
    <div>
      <h1>
        #{lead.id} {lead.firstName} {lead.lastName}{' '}
        <span className="badge tier">{lead.currentTier}</span>{' '}
        <span className={`badge ${lead.status}`}>{lead.status}</span>
        {lead.workStatus && <span className="badge QUALIFIED" style={{ marginLeft: 6 }}>{lead.workStatus.label}</span>}
        {lead.status === 'CLOSED_WON' && lead.currentTier === 'CLOSER' && (
          <span className="muted" style={{ fontSize: '0.8rem', marginLeft: 10 }}>
            🏁 won — post-sale processing stays with {lead.assignedTo?.name ?? 'the Closer'}
          </span>
        )}
      </h1>

      <div className="grid cols2">
        <LeadInfoCard lead={lead} onSaved={load}>
          <h2 style={{ marginTop: 18 }}>Actions</h2>
          <div className="row">
            {/* T1 — the Agent decides: direct handoff to a chosen Agent / Sr Agent */}
            {can('request_transfer') && isAssignedToMe && isOpen && !isPending && lead.currentTier === 'AGENT' && (
              <DirectTransfer leadId={lead.id} act={act} />
            )}
            {/* T2 — Sr Agent sends the lead up into the common Manager bucket */}
            {can('request_transfer') && isAssignedToMe && isOpen && !isPending && lead.currentTier === 'SR_AGENT' && (
              <button onClick={() => act(() => post(`/routing/leads/${lead.id}/request-transfer`, {}), 'Sent to the Manager bucket — a manager will route it to a Closer.')}>
                Send to Manager Bucket ↑
              </button>
            )}
            {can('close_deal') && isOpen && lead.currentTier === 'CLOSER' && isAssignedToMe && (
              <>
                <button className="success" onClick={() => act(() => post(`/routing/leads/${lead.id}/close`, { outcome: 'CLOSED_WON' }), 'Deal WON 🎉')}>
                  Close Won
                </button>
                <button className="danger" onClick={() => act(() => post(`/routing/leads/${lead.id}/close`, { outcome: 'CLOSED_LOST' }), 'Closed lost.')}>
                  Close Lost
                </button>
              </>
            )}
            {can('send_back') && isOpen && lead.currentTier === 'CLOSER' && isAssignedToMe && !isPending && (
              <button className="warn" onClick={() => {
                const reason = prompt('Why is this lead being sent back?');
                if (reason) act(() => post(`/routing/leads/${lead.id}/send-back`, { reason }), 'Sent back to the Admin queue.');
              }}>
                Send Back ↓
              </button>
            )}
            {can('route_leads') && !isOpen && (
              <button className="ghost" onClick={() => {
                const reason = prompt('Reason for reopening?');
                if (reason) act(() => post(`/routing/leads/${lead.id}/reopen`, { reason }), 'Reopened into the routing queue.');
              }}>
                Reopen
              </button>
            )}
          </div>
          {isPending && (
            <p className="muted" style={{ marginTop: 10 }}>
              ⏳ Waiting in the Manager bucket{lead.queueEntries[0] ? ` (${lead.queueEntries[0].transferPoint})` : ''} — a manager or admin will route it.
            </p>
          )}
          {msg && <div className="ok">{msg}</div>}
          {error && <div className="error">{error}</div>}
        </LeadInfoCard>

        <div className="card">
          <h2>Timeline</h2>
          {can('log_activity') && !callable && noteType === 'CALL' && (
            <div className="error" style={{ marginBottom: 8 }}>
              ⛔ This lead is not callable (DNC/litigator) — call logging is blocked by the server.
            </div>
          )}
          {can('log_activity') && (
            <form onSubmit={logActivity} className="row" style={{ marginBottom: 14 }}>
              <select value={noteType} onChange={(e) => setNoteType(e.target.value as 'CALL' | 'NOTE')}>
                <option value="CALL">Call</option>
                <option value="NOTE">Note</option>
              </select>
              <input style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
              <button type="submit">Log</button>
            </form>
          )}
          <ul className="timeline">
            {lead.activities.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.type}</strong> — {a.detail}
                </div>
                <div className="when">
                  {a.user.name} · {new Date(a.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <CommentsCard leadId={lead.id} />
      <EnrichmentPanel leadId={lead.id} onCallableChange={setCallable} />
      <BackgroundCard leadId={lead.id} />
      <LeadAccessCard leadId={lead.id} />
    </div>
  );
}

interface Recipient {
  id: number;
  name: string;
  role: { roleCode: string; displayName: string };
  office: { id: number; name: string } | null;
  _count: { assignedLeads: number };
}

/**
 * T1 — the Agent's own routing decision: pick an Agent or Sr Agent (office-wise
 * list from the server) and transfer immediately. No queue, no waiting.
 */
function DirectTransfer({ leadId, act }: { leadId: number; act: (fn: () => Promise<unknown>, okMsg: string) => Promise<void> }) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [toUserId, setToUserId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Recipient[]>(`/routing/leads/${leadId}/direct-recipients`).then(setRecipients).catch(() => setRecipients([]));
  }, [leadId]);

  const transfer = async () => {
    if (!toUserId) return;
    setBusy(true);
    const target = recipients.find((r) => r.id === Number(toUserId));
    await act(
      () => post(`/routing/leads/${leadId}/direct-transfer`, { toUserId: Number(toUserId) }),
      `Transferred to ${target?.name ?? 'colleague'}.`,
    );
    setBusy(false);
    setToUserId('');
  };

  return (
    <div className="row" style={{ alignItems: 'center', gap: 8 }}>
      <select value={toUserId} onChange={(e) => setToUserId(e.target.value)} style={{ minWidth: 220 }}>
        <option value="">Transfer to… (Agent / Sr Agent)</option>
        {recipients.filter((r) => r.role.roleCode === 'SR_AGENT').length > 0 && (
          <optgroup label="Sr Agents (moves lead to T2)">
            {recipients.filter((r) => r.role.roleCode === 'SR_AGENT').map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}{r.office ? ` · ${r.office.name}` : ''} ({r._count.assignedLeads} open)
              </option>
            ))}
          </optgroup>
        )}
        {recipients.filter((r) => r.role.roleCode === 'AGENT').length > 0 && (
          <optgroup label="Agents (stays at T1)">
            {recipients.filter((r) => r.role.roleCode === 'AGENT').map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}{r.office ? ` · ${r.office.name}` : ''} ({r._count.assignedLeads} open)
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button onClick={transfer} disabled={!toUserId || busy}>
        {busy ? 'Transferring…' : 'Transfer ➜'}
      </button>
    </div>
  );
}
