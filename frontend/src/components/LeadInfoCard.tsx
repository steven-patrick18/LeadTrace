import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { api, get, patch, post } from '../api';
import { useAuth } from '../auth';

interface FieldDef {
  id: number;
  label: string;
  fieldType: 'TEXT' | 'NUMBER' | 'DATE' | 'DROPDOWN';
  options: string[] | null;
}

interface LeadInfo {
  id: number;
  firstName: string;
  lastName: string;
  primaryPhone: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  sourceProvider: string | null;
  createdAt: string;
  assignedTo: { id: number; name: string } | null;
  createdBy: { id: number; name: string };
  phones: Array<{ id: number; phone: string; lineType: string | null; isPrimary: boolean }>;
  customValues: Array<{ fieldId: number; value: string }>;
}

/**
 * One card for everything about the lead: contact details AND the admin-defined
 * process fields, all inline-editable. Who may edit is decided by the
 * edit_lead permission + scope (OWN / ASSIGNED / ALL) — enforced server-side;
 * without it the card renders read-only. Admins can add new form fields
 * right here.
 */
export function LeadInfoCard({ lead, onSaved, children }: { lead: LeadInfo; onSaved: () => void; children?: ReactNode }) {
  const { can } = useAuth();
  const canEdit = can('edit_lead');
  const canAddFields = can('manage_custom_fields');

  const [defs, setDefs] = useState<FieldDef[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showNewField, setShowNewField] = useState(false);

  useEffect(() => {
    get<FieldDef[]>('/custom-fields').then(setDefs).catch(() => setDefs([]));
  }, []);

  const flash = (m: string) => {
    setMsg(m);
    setError('');
    setTimeout(() => setMsg(''), 3000);
  };
  const fail = (err: unknown) => {
    setError(err instanceof Error ? err.message : 'Save failed');
    setMsg('');
  };

  // ── built-in contact fields ──
  const BUILTINS: Array<{ key: string; label: string; value: string }> = [
    { key: 'firstName', label: 'First name', value: lead.firstName },
    { key: 'lastName', label: 'Last name', value: lead.lastName },
    { key: 'primaryPhone', label: 'Primary phone', value: lead.primaryPhone },
    { key: 'address', label: 'Address', value: lead.address ?? '' },
    { key: 'city', label: 'City', value: lead.city ?? '' },
    { key: 'state', label: 'State', value: lead.state ?? '' },
    { key: 'zip', label: 'ZIP', value: lead.zip ?? '' },
  ];
  const builtinKey = (k: string) => `b:${k}`;
  const dirtyBuiltins = BUILTINS.filter(
    (b) => edits[builtinKey(b.key)] !== undefined && edits[builtinKey(b.key)] !== b.value,
  );

  const saveBuiltins = async () => {
    try {
      const body: Record<string, string> = {};
      for (const b of dirtyBuiltins) body[b.key] = edits[builtinKey(b.key)];
      await patch(`/leads/${lead.id}`, body);
      setEdits((e) => {
        const next = { ...e };
        for (const b of dirtyBuiltins) delete next[builtinKey(b.key)];
        return next;
      });
      flash('Details saved.');
      onSaved();
    } catch (err) {
      fail(err);
    }
  };

  // ── custom process fields ──
  const valueOf = (fieldId: number) => lead.customValues.find((v) => v.fieldId === fieldId)?.value ?? '';
  const customKey = (id: number) => `c:${id}`;

  const saveCustom = async (field: FieldDef) => {
    try {
      await api('PUT', `/leads/${lead.id}/custom-values`, { fieldId: field.id, value: edits[customKey(field.id)] ?? '' });
      setEdits((e) => {
        const next = { ...e };
        delete next[customKey(field.id)];
        return next;
      });
      flash(`"${field.label}" saved.`);
      onSaved();
    } catch (err) {
      fail(err);
    }
  };

  const row = (label: string, control: ReactNode, action?: ReactNode) => (
    <tr key={label}>
      <td style={{ width: 170, color: 'var(--muted)', verticalAlign: 'middle' }}>{label}</td>
      <td>{control}</td>
      <td style={{ width: 70 }}>{action}</td>
    </tr>
  );

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Lead details</h2>
        {!canEdit && <span className="muted" style={{ fontSize: '0.75rem' }}>read-only for your role</span>}
      </div>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <table style={{ marginTop: 10 }}>
        <tbody>
          {BUILTINS.map((b) =>
            row(
              b.label,
              canEdit ? (
                <input
                  value={edits[builtinKey(b.key)] !== undefined ? edits[builtinKey(b.key)] : b.value}
                  onChange={(e) => setEdits({ ...edits, [builtinKey(b.key)]: e.target.value })}
                  style={{ width: '100%', maxWidth: 300 }}
                />
              ) : (
                <span>{b.value || <span className="muted">—</span>}</span>
              ),
            ),
          )}
          {defs.map((f) => {
            const current = edits[customKey(f.id)] !== undefined ? edits[customKey(f.id)] : valueOf(f.id);
            const dirty = edits[customKey(f.id)] !== undefined && edits[customKey(f.id)] !== valueOf(f.id);
            return row(
              f.label,
              !canEdit ? (
                <span>{valueOf(f.id) || <span className="muted">—</span>}</span>
              ) : f.fieldType === 'DROPDOWN' ? (
                <select value={current} onChange={(e) => setEdits({ ...edits, [customKey(f.id)]: e.target.value })}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.fieldType === 'NUMBER' ? 'number' : f.fieldType === 'DATE' ? 'date' : 'text'}
                  value={current}
                  onChange={(e) => setEdits({ ...edits, [customKey(f.id)]: e.target.value })}
                  style={{ width: '100%', maxWidth: 300 }}
                />
              ),
              canEdit && dirty ? <button className="sm" onClick={() => saveCustom(f)}>Save</button> : undefined,
            );
          })}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 12 }}>
        {canEdit && dirtyBuiltins.length > 0 && (
          <button onClick={saveBuiltins}>Save details ({dirtyBuiltins.length})</button>
        )}
        {canAddFields && (
          <button className="ghost sm" onClick={() => setShowNewField(!showNewField)}>
            {showNewField ? 'Cancel' : '+ New form field'}
          </button>
        )}
      </div>

      {showNewField && (
        <NewFieldForm
          onDone={async () => {
            setShowNewField(false);
            setDefs(await get<FieldDef[]>('/custom-fields'));
            flash('Field added — it now appears on every lead.');
          }}
          onErr={fail}
        />
      )}

      {lead.phones.filter((p) => !p.isPrimary).length > 0 && (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10 }}>
          Other phones: {lead.phones.filter((p) => !p.isPrimary).map((p) => `${p.phone} (${p.lineType ?? 'unknown'})`).join(' · ')}
        </p>
      )}
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Source: {lead.sourceProvider ?? 'manual'} · Created by {lead.createdBy.name} on{' '}
        {new Date(lead.createdAt).toLocaleDateString()} · Assigned to:{' '}
        <strong style={{ color: 'var(--text)' }}>{lead.assignedTo?.name ?? '—'}</strong>
        <br />
        Every change is recorded on the timeline and audit log.
      </p>

      {children}
    </div>
  );
}

function NewFieldForm({ onDone, onErr }: { onDone: () => void; onErr: (e: unknown) => void }) {
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState('TEXT');
  const [options, setOptions] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post('/custom-fields', {
        label,
        fieldType,
        ...(fieldType === 'DROPDOWN'
          ? { options: options.split(',').map((o) => o.trim()).filter(Boolean) }
          : {}),
      });
      setLabel('');
      setOptions('');
      onDone();
    } catch (err) {
      onErr(err);
    }
  };

  return (
    <form onSubmit={submit} className="row" style={{ marginTop: 10, background: 'var(--panel2)', borderRadius: 8, padding: 10 }}>
      <div className="field">
        <label>Field name</label>
        <input required minLength={2} value={label} onChange={(e) => setLabel(e.target.value)} placeholder='e.g. "Policy number"' />
      </div>
      <div className="field">
        <label>Type</label>
        <select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="DATE">Date</option>
          <option value="DROPDOWN">Dropdown</option>
        </select>
      </div>
      {fieldType === 'DROPDOWN' && (
        <div className="field" style={{ flex: 1 }}>
          <label>Options (comma-separated)</label>
          <input required value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Hot, Warm, Cold" />
        </div>
      )}
      <button type="submit">Add field</button>
    </form>
  );
}
