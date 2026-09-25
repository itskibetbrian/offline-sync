import type {
  Conflict,
  LocalMutation,
  SyncStatus,
  TradeRecord
} from "../types";
import { pendingProjection, sortConflicts } from "./reconciliation";

export type SyncState = {
  records: Record<string, TradeRecord>;
  pending: LocalMutation[];
  conflicts: Conflict[];
  online: boolean;
  syncing: boolean;
  error: boolean;
};

export function statusOf(state: SyncState): SyncStatus {
  if (state.conflicts.length > 0) return "conflict";
  if (state.syncing) return "syncing";
  if (!state.online) return "offline";
  if (state.error) return "error";
  return "online";
}

export function canonicalState(state: SyncState) {
  return {
    records: state.records,
    pendingOperations: pendingProjection(state.pending),
    syncStatus: statusOf(state),
    conflicts: sortConflicts(state.conflicts)
  };
}
