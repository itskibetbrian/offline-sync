import { useEffect, useMemo, useState } from "react";
import type { TradeRecord } from "../types";

const STATUS_OPTIONS = ["draft", "active", "complete"] as const;

export function RecordEditor({
  record,
  onSave
}: {
  record: TradeRecord;
  onSave: (fields: Partial<TradeRecord>) => void;
}) {
  const [title, setTitle] = useState(record.title);
  const [notes, setNotes] = useState(record.notes);
  const [status, setStatus] = useState(record.status);

  // Reset the form whenever a different record or server version arrives.
  // Without this the inputs go stale after remote updates (screenshot bug).
  useEffect(() => {
    setTitle(record.title);
    setNotes(record.notes);
    setStatus(record.status);
  }, [record.id, record.title, record.notes, record.status]);

  const dirty = useMemo(
    () => title !== record.title || notes !== record.notes || status !== record.status,
    [title, notes, status, record]
  );

  return (
    <section aria-label="Record editor" style={styles.section}>
      <h2 style={styles.h2}>Record</h2>
      <div style={styles.meta}>
        <span data-testid="record-id">ID: {record.id}</span>
        <span data-testid="record-version">Version: {record.version}</span>
      </div>
      <div style={styles.grid}>
        <label style={styles.label}>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="record-title"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="record-notes"
            style={styles.textarea}
          />
        </label>
        <label style={styles.label}>
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TradeRecord["status"])}
            data-testid="record-status"
            style={styles.input}
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="complete">Complete</option>
            {!(STATUS_OPTIONS as readonly string[]).includes(status) && (
              <option value={status}>{status}</option>
            )}
          </select>
        </label>
      </div>
      <button
        data-testid="save-record"
        disabled={!dirty}
        onClick={() => onSave({ title, notes, status })}
        style={dirty ? styles.save : styles.saveDisabled}
      >
        Save changes
      </button>
      {!dirty && <span style={styles.hint}>No unsaved changes.</span>}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginTop: 16 },
  h2: { margin: "0 0 8px" },
  meta: { display: "flex", gap: 16, color: "#555", fontSize: 13, marginBottom: 12 },
  grid: { display: "grid", gap: 12, gridTemplateColumns: "1fr" },
  label: { display: "grid", gap: 4, fontSize: 14, fontWeight: 600 },
  input: { padding: 8, fontSize: 14, borderRadius: 4, border: "1px solid #bbb" },
  textarea: { padding: 8, fontSize: 14, borderRadius: 4, border: "1px solid #bbb", minHeight: 60 },
  save: { marginTop: 12, padding: "8px 14px", cursor: "pointer" },
  saveDisabled: { marginTop: 12, padding: "8px 14px", opacity: 0.5 },
  hint: { marginLeft: 10, fontSize: 13, color: "#666" }
};
