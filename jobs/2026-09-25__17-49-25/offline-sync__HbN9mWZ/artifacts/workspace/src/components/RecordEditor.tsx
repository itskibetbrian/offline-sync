import { useState } from "react";
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

  return (
    <section>
      <h2>Record</h2>
      <label>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <label>
        Status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TradeRecord["status"])}
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="complete">Complete</option>
          {!(STATUS_OPTIONS as readonly string[]).includes(status) && (
            <option value={status}>{status}</option>
          )}
        </select>
      </label>
      <button
        onClick={() => onSave({ title, notes, status })}
      >
        Save
      </button>
    </section>
  );
}
