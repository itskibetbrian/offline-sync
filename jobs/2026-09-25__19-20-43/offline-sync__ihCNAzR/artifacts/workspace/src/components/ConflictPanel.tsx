import { useState } from "react";
import type { Conflict } from "../types";

export function ConflictPanel({
  conflicts,
  resolve
}: {
  conflicts: Conflict[];
  resolve: (conflict: Conflict, value: string) => void;
}) {
  const [custom, setCustom] = useState<Record<string, string>>({});

  return (
    <section aria-label="Conflicts" style={styles.section}>
      <h2 style={styles.h2}>Conflicts ({conflicts.length})</h2>
      {conflicts.length === 0 ? (
        <p style={styles.muted}>No unresolved conflicts.</p>
      ) : (
        conflicts.map((c) => {
          const key = `${c.recordId}:${c.field}`;
          return (
            <div
              key={key}
              data-testid={`conflict-${c.recordId}-${c.field}`}
              style={styles.card}
            >
              <strong>
                {c.recordId} / {String(c.field)}
              </strong>
              <div style={styles.values}>
                <span>Local: {c.localValue}</span>
                <span>Remote: {c.remoteValue}</span>
              </div>
              <div style={styles.row}>
                <button
                  data-testid={`keep-local-${c.recordId}-${c.field}`}
                  onClick={() => resolve(c, c.localValue)}
                >
                  Keep local
                </button>
                <button
                  data-testid={`keep-remote-${c.recordId}-${c.field}`}
                  onClick={() => resolve(c, c.remoteValue)}
                >
                  Keep remote
                </button>
                <input
                  aria-label={`Custom value for ${key}`}
                  placeholder="Custom value"
                  value={custom[key] ?? ""}
                  onChange={(e) => setCustom((m) => ({ ...m, [key]: e.target.value }))}
                  data-testid={`custom-${c.recordId}-${c.field}`}
                  style={styles.input}
                />
                <button
                  data-testid={`resolve-custom-${c.recordId}-${c.field}`}
                  disabled={!custom[key]}
                  onClick={() => resolve(c, custom[key])}
                >
                  Resolve
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginTop: 16 },
  h2: { margin: "0 0 8px" },
  muted: { color: "#666", fontSize: 13 },
  card: { border: "1px solid #e0d7f5", borderRadius: 6, padding: 10, marginTop: 8 },
  values: { display: "flex", gap: 16, fontSize: 13, margin: "6px 0" },
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  input: { padding: 6, fontSize: 13, borderRadius: 4, border: "1px solid #bbb" }
};
