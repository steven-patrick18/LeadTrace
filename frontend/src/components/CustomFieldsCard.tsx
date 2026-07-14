import { useEffect, useState } from 'react';
import { api, get } from '../api';
import { useAuth } from '../auth';

interface FieldDef {
  id: number;
  label: string;
  fieldType: 'TEXT' | 'NUMBER' | 'DATE' | 'DROPDOWN';
  options: string[] | null;
}

interface FieldValue {
  fieldId: number;
  value: string;
}

/**
 * Admin-defined process fields on a lead. Values stay editable — whenever an
 * agent confirms details with the customer, they update here and the change
 * lands on the timeline.
 */
export function CustomFieldsCard({ leadId, values, onSaved }: { leadId: number; values: Array<{ fieldId: number; value: string }>; onSaved: () => void }) {
  const { can } = useAuth();
  const [defs, setDefs] = useState<FieldDef[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    get<FieldDef[]>('/custom-fields').then(setDefs).catch(() => setDefs([]));
  }, []);

  if (defs.length === 0) return null;
  const valueOf = (fieldId: number) => values.find((v) => v.fieldId === fieldId)?.value ?? '';
  const canEdit = can('edit_lead');

  const save = async (field: FieldDef) => {
    setError('');
    setSavedMsg('');
    try {
      await api('PUT', `/leads/${leadId}/custom-values`, { fieldId: field.id, value: edits[field.id] ?? '' });
      setSavedMsg(`"${field.label}" saved.`);
      setEdits((e) => {
        const next = { ...e };
        delete next[field.id];
        return next;
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <div className="card">
      <h2>Process fields</h2>
      {error && <div className="error">{error}</div>}
      {savedMsg && <div className="ok">{savedMsg}</div>}
      <table style={{ maxWidth: 680 }}>
        <tbody>
          {defs.map((f) => {
            const current = edits[f.id] !== undefined ? edits[f.id] : valueOf(f.id);
            const dirty = edits[f.id] !== undefined && edits[f.id] !== valueOf(f.id);
            return (
              <tr key={f.id}>
                <td style={{ width: 220, color: 'var(--muted)' }}>{f.label}</td>
                <td>
                  {!canEdit ? (
                    <span>{valueOf(f.id) || <span className="muted">—</span>}</span>
                  ) : f.fieldType === 'DROPDOWN' ? (
                    <select value={current} onChange={(e) => setEdits({ ...edits, [f.id]: e.target.value })}>
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => <option key={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      type={f.fieldType === 'NUMBER' ? 'number' : f.fieldType === 'DATE' ? 'date' : 'text'}
                      value={current}
                      onChange={(e) => setEdits({ ...edits, [f.id]: e.target.value })}
                      style={{ width: '100%', maxWidth: 320 }}
                    />
                  )}
                </td>
                <td style={{ width: 80 }}>
                  {canEdit && dirty && (
                    <button className="sm" onClick={() => save(f)}>Save</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>
        Fields are defined by the Admin in Settings. Every change is recorded on the timeline.
      </p>
    </div>
  );
}
