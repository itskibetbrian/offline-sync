import type { SyncStatus } from "../types";

export function SyncStatusView({
  status,
  pending,
  online,
  error
}: {
  status: SyncStatus;
  pending: Array<{ id: number; recordId: string; fields: string[]; baseVersion: number }>;
  online: boolean;
  error: boolean;
}) {
  return (
    <section aria-label="Sync status" style={styles.section}>
      <h2 style={styles.h2}>Sync</h2>
      <div style={styles.row}>
        <span data-testid="sync-status" style={{ ...styles.badge, ...badgeColor(status) }}>
          {status}
        </span>
        <span data-testid="pending-count" title="pending operations">
          {pending.length} pending
        </span>
        <span data-testid="connectivity">{online ? "online" : "offline"}</span>
        {error && <span data-testid="sync-error">retryable error</span>}
      </div>
      {pending.length > 0 ? (
        <table data-testid="pending-list" style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>op</th>
              <th style={styles.th}>record</th>
              <th style={styles.th}>fields</th>
              <th style={styles.th}>base</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((op) => (
              <tr key={op.id}>
                <td style={styles.td}>#{op.id}</td>
                <td style={styles.td}>{op.recordId}</td>
                <td style={styles.td}>{op.fields.join(", ")}</td>
                <td style={styles.td}>v{op.baseVersion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={styles.muted}>No pending operations.</p>
      )}
    </section>
  );
}

function badgeColor(status: SyncStatus): React.CSSProperties {
  switch (status) {
    case "online":
      return { background: "#e6f4ea", color: "#137333" };
    case "syncing":
      return { background: "#fef7e0", color: "#925500" };
    case "offline":
      return { background: "#e8eaed", color: "#444" };
    case "error":
      return { background: "#fce8e6", color: "#a50e0e" };
    case "conflict":
      return { background: "#f3e8fd", color: "#681da8" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  section: { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginTop: 16 },
  h2: { margin: "0 0 8px" },
  row: { display: "flex", gap: 12, alignItems: "center", fontSize: 14 },
  badge: { padding: "2px 10px", borderRadius: 999, fontWeight: 700 },
  table: { marginTop: 12, borderCollapse: "collapse", fontSize: 13, width: "100%" },
  th: { textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 },
  td: { borderBottom: "1px solid #eee", padding: 4 },
  muted: { color: "#666", fontSize: 13 }
};
