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
      <div data-testid="sync-status">{status}</div>
      <div data-testid="pending-count">{pending}</div>
    </section>
  );
}
