import { useEffect, useMemo, useState } from "react";
import { adapter } from "./adapter/serverAdapter";
import { ConflictPanel } from "./components/ConflictPanel";
import { RecordEditor } from "./components/RecordEditor";
import { SyncStatusView } from "./components/SyncStatus";
import { SyncEngine } from "./sync/syncEngine";

const engine = new SyncEngine();

export default function App() {
  const [, redraw] = useState(0);

  useEffect(() => engine.subscribe(() => redraw((x) => x + 1)), []);

  const state = engine.getState();
  const record = useMemo(
    () => Object.values(state.records)[0],
    [state.records]
  );

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}>
      <h1>Offline Sync</h1>

      <button
        onClick={() => adapter.setOnline(!adapter.isOnline())}
      >
        Toggle connection
      </button>

      {record && (
        <RecordEditor
          record={record}
          onSave={(fields) => engine.create(record.id, fields)}
        />
      )}

      <SyncStatusView
        status={state.syncStatus}
        pending={state.pendingOperations.length}
      />

      <ConflictPanel
        conflicts={state.conflicts}
        resolve={(conflict, value) =>
          engine.resolveConflict(
            conflict.recordId,
            conflict.field as "title" | "notes" | "status",
            value
          )
        }
      />

      <pre>
        {JSON.stringify(state, null, 2)}
      </pre>
    </main>
  );
}
