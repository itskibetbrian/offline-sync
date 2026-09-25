import type { SyncStatus } from "../types";

export function SyncStatusView({
  status,
  pending
}: {
  status: SyncStatus;
  pending: number;
}) {
  return (
    <section>
      <h2>Sync</h2>
      <div>{status}</div>
      <div>{pending}</div>
    </section>
  );
}
