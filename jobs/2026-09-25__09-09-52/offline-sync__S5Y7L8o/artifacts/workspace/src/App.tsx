import { useEffect, useState } from "react";
import { adapter } from "./adapter/serverAdapter";
import { ConflictPanel } from "./components/ConflictPanel";
import { RecordEditor } from "./components/RecordEditor";
import { SyncStatusView } from "./components/SyncStatus";
import { resetPersisted } from "./storage/persistence";
import { SyncEngine } from "./sync/syncEngine";

const engine = new SyncEngine();

declare global {
  interface Window {
    __OFFLINE_SYNC_STATE__?: () => unknown;
    __OFFLINE_SYNC_ADAPTER__?: unknown;
    __OFFLINE_SYNC_READY__?: boolean;
    __OFFLINE_SYNC_RESET__?: () => void;
  }
}

function installTestHooks() {
  window.__OFFLINE_SYNC_STATE__ = () => engine.getState();
  window.__OFFLINE_SYNC_ADAPTER__ = {
    setOnline: (online: boolean) => adapter.setOnline(online),
    isOnline: () => adapter.isOnline(),
    pendingRequests: () => adapter.pendingRequests(),
    ack: (mutationId: number, record: unknown) =>
      adapter.emit({ type: "ack", mutationId, record: record as never }),
    stale: (mutationId: number, record: unknown) =>
      adapter.emit({ type: "stale", mutationId, record: record as never }),
    remote: (record: unknown) => adapter.emit({ type: "remote", record: record as never }),
    failure: (mutationId: number) => adapter.emit({ type: "failure", mutationId })
  };
  window.__OFFLINE_SYNC_RESET__ = () => {
    resetPersisted();
    adapter.reset();
    window.location.reload();
  };
  window.__OFFLINE_SYNC_READY__ = true;
}

export default function App() {
  const [, redraw] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    installTestHooks();
    return engine.subscribe(() => redraw((x) => x + 1));
  }, []);

  // Install synchronously too so the verifier can call it immediately.
  window.__OFFLINE_SYNC_STATE__ = () => engine.getState();

  const state = engine.getState();
  const records = Object.values(state.records).sort((a, b) => a.id.localeCompare(b.id));
  const selected = records.find((r) => r.id === selectedId) ?? records[0] ?? null;
  const online = adapter.isOnline();

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Offline Sync</h1>
        <button data-testid="toggle-connectivity" onClick={() => adapter.setOnline(!online)}>
          {online ? "Go offline" : "Go online"} (currently {online ? "online" : "offline"})
        </button>
      </header>

      <div style={styles.layout}>
        <aside style={styles.sidebar} aria-label="Records">
          <h2 style={styles.h2}>Records</h2>
          <ul data-testid="record-list" style={styles.list}>
            {records.map((r) => (
              <li key={r.id}>
                <button
                  data-testid={`select-record-${r.id}`}
                  onClick={() => setSelectedId(r.id)}
                  style={r.id === selected?.id ? styles.active : styles.recordBtn}
                >
                  {r.id} · {r.title} (v{r.version}){r.deleted ? " [deleted]" : ""}
                </button>
                {r.deleted ? (
                  <button
                    data-testid={`restore-record-${r.id}`}
                    onClick={() => engine.restoreRecord(r.id)}
                    style={styles.smallBtn}
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    data-testid={`delete-record-${r.id}`}
                    onClick={() => engine.remove(r.id)}
                    style={styles.smallBtn}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <div style={styles.main}>
          {selected && (
            <RecordEditor
              key={selected.id}
              record={selected}
              onSave={(fields) => engine.create(selected.id, fields)}
            />
          )}

          <SyncStatusView
            status={state.syncStatus}
            pending={state.pendingOperations}
            online={online}
            error={state.syncStatus === "error"}
          />

          <ConflictPanel
            conflicts={state.conflicts}
            resolve={(conflict, value) =>
              engine.resolveConflict(
                conflict.recordId,
                conflict.field,
                value
              )
            }
          />

          <details style={styles.debug}>
            <summary>Debug state (read-only projection)</summary>
            <pre data-testid="state-json">{JSON.stringify(state, null, 2)}</pre>
          </details>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 960, margin: "0 auto", padding: 20, fontFamily: "system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  h1: { margin: 0 },
  layout: { display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, marginTop: 16 },
  sidebar: { border: "1px solid #ddd", borderRadius: 8, padding: 12, height: "fit-content" },
  h2: { margin: "0 0 8px", fontSize: 18 },
  list: { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 },
  recordBtn: { width: "100%", textAlign: "left", padding: "6px 8px", cursor: "pointer" },
  active: { width: "100%", textAlign: "left", padding: "6px 8px", cursor: "pointer", fontWeight: 700 },
  smallBtn: { marginLeft: 6, padding: "4px 8px", cursor: "pointer", fontSize: 12 },
  main: { minWidth: 0 },
  debug: { marginTop: 16, fontSize: 12, color: "#333" }
};
