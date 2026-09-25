export type RecordStatus = "draft" | "active" | "complete";

export type TradeRecord = {
  id: string;
  title: string;
  notes: string;
  status: RecordStatus;
  version: number;
};

export type MutationFields = Partial<
  Pick<TradeRecord, "title" | "notes" | "status">
>;

export type LocalMutation = {
  id: number;
  recordId: string;
  fields: MutationFields;
  baseVersion: number;
};

export type Conflict = {
  recordId: string;
  field: keyof MutationFields;
  localValue: string;
  remoteValue: string;
};

export type SyncStatus =
  | "online"
  | "offline"
  | "syncing"
  | "conflict"
  | "error";

export type CanonicalState = {
  records: Record<string, TradeRecord>;
  pendingOperations: Array<{
    id: number;
    recordId: string;
    fields: string[];
    baseVersion: number;
  }>;
  syncStatus: SyncStatus;
  conflicts: Conflict[];
};
