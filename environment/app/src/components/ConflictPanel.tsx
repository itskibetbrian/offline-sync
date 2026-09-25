import type { Conflict } from "../types";

export function ConflictPanel({
  conflicts,
  resolve
}: {
  conflicts: Conflict[];
  resolve: (conflict: Conflict, value: string) => void;
}) {
  return (
    <section>
      <h2>Conflicts</h2>
      {conflicts.map((c) => (
        <div
          key={`${c.recordId}:${c.field}`}
          data-testid={`conflict-${c.recordId}-${c.field}`}
        >
          <strong>{c.field}</strong>
          <div>Local: {c.localValue}</div>
          <div>Remote: {c.remoteValue}</div>
          <button onClick={() => resolve(c, c.localValue)}>
            Keep local
          </button>
          <button onClick={() => resolve(c, c.remoteValue)}>
            Keep remote
          </button>
        </div>
      ))}
    </section>
  );
}
