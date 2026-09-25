import type { LocalMutation, MutationFields, TradeRecord } from "../types";
import { load, save } from "../storage/persistence";

export class OperationLog {
  private state = load();

  get records() {
    return this.state.records;
  }

  get pending() {
    return this.state.pending;
  }

  get conflicts() {
    return this.state.conflicts;
  }

  get online() {
    return true;
  }

  createMutation(record: TradeRecord, fields: MutationFields): LocalMutation {
    const op: LocalMutation = {
      id: this.state.nextId++,
      recordId: record.id,
      fields,
      baseVersion: record.version
    };

    this.state.records[record.id] = { ...record, ...fields };
    this.state.pending.push(op);
    save(this.state);
    return op;
  }

  persist() {
    save(this.state);
  }

  setRecords(records: Record<string, TradeRecord>) {
    this.state.records = records;
    save(this.state);
  }

  setPending(pending: LocalMutation[]) {
    this.state.pending = pending;
    save(this.state);
  }

  setConflicts(conflicts: typeof this.state.conflicts) {
    this.state.conflicts = conflicts;
    save(this.state);
  }
}
