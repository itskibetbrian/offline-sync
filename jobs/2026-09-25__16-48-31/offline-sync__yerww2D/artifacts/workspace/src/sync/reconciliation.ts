import type {
  Conflict,
  LocalMutation,
  TradeRecord
} from "../types";

export function normalizedFields(fields: LocalMutation["fields"]): string[] {
  return Object.keys(fields).sort();
}

export function pendingProjection(pending: LocalMutation[]) {
  return [...pending]
    .sort((a, b) => a.id - b.id)
    .map((op) => ({
      id: op.id,
      recordId: op.recordId,
      fields: normalizedFields(op.fields),
      baseVersion: op.baseVersion,
      ...(op.deleted !== undefined ? { deleted: op.deleted } : {})
    }));
}

export function sortConflicts(conflicts: Conflict[]) {
  return [...conflicts].sort(
    (a, b) =>
      a.recordId.localeCompare(b.recordId) ||
      String(a.field).localeCompare(String(b.field))
  );
}

export function mergeNonConflicting(
  local: TradeRecord,
  remote: TradeRecord,
  changedLocally: Set<string>,
  changedRemotely: Set<string>
) {
  const result = { ...remote };

  for (const field of ["title", "notes", "status"] as const) {
    if (changedLocally.has(field) && !changedRemotely.has(field)) {
      result[field] = local[field] as never;
    }
  }

  return result;
}
