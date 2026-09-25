import { adapter } from "../adapter/serverAdapter";
import type { LocalMutation, TradeRecord } from "../types";
import { load, save } from "../storage/persistence";
import { canonicalState, type SyncState } from "./state";

const EDITABLE = ["title", "notes", "status"] as const;

export class SyncEngine {
  private state: SyncState;
  private listeners = new Set<() => void>();
  private activeRequest: number | null = null;

  constructor() {
    const p = load();
    this.state = {
      records: p.records,
      pending: p.pending,
      conflicts: p.conflicts,
      online: adapter.isOnline(),
      syncing: false,
      error: false
    };

    adapter.subscribe((event) => {
      if (event.type === "connectivity") {
        this.state.online = event.online;
        if (event.online) this.flush();
        this.persist();
        this.emit();
      } else if (event.type === "ack") {
        this.ack(event.mutationId, event.record);
      } else if (event.type === "stale") {
        this.stale(event.mutationId, event.record);
      } else if (event.type === "remote") {
        this.remote(event.record);
      } else if (event.type === "failure") {
        if (this.activeRequest === event.mutationId) this.activeRequest = null;
        this.state.syncing = false;
        this.state.error = true;
        this.persist();
        this.emit();
      }
    });

    this.flush();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState() {
    return canonicalState(this.state);
  }

  create(recordId: string, fields: Partial<TradeRecord>) {
    const record = this.state.records[recordId];
    if (!record) throw new Error("Unknown record");

    const clean: LocalMutation["fields"] = {};
    for (const field of EDITABLE) {
      if (fields[field] !== undefined && fields[field] !== record[field]) {
        clean[field] = fields[field] as never;
      }
    }
    if (Object.keys(clean).length === 0) return;

    const p = load();
    const op: LocalMutation = {
      id: p.nextId,
      recordId,
      fields: clean,
      baseVersion: record.version
    };

    p.nextId += 1;
    p.pending.push(op);
    p.records[recordId] = { ...record, ...clean };
    p.conflicts = p.conflicts.filter(
      (c) => !(c.recordId === recordId && Object.keys(clean).includes(c.field))
    );
    save(p);

    this.state = {
      ...this.state,
      records: p.records,
      pending: p.pending,
      conflicts: p.conflicts,
      error: false
    };

    this.emit();
    this.flush();
  }

  resolveConflict(
    recordId: string,
    field: "title" | "notes" | "status",
    value: string
  ) {
    const conflict = this.state.conflicts.find(
      (c) => c.recordId === recordId && c.field === field
    );
    if (!conflict) return;

    this.create(recordId, { [field]: value } as Partial<TradeRecord>);
    this.state.conflicts = this.state.conflicts.filter(
      (c) => !(c.recordId === recordId && c.field === field)
    );
    this.persist();
    this.emit();
  }

  private flush() {
    if (!this.state.online || this.activeRequest !== null) return;

    const op = [...this.state.pending].sort((a, b) => a.id - b.id)[0];
    if (!op) {
      this.state.syncing = false;
      this.emit();
      return;
    }

    this.activeRequest = op.id;
    this.state.syncing = true;
    this.state.error = false;
    this.emit();
    adapter.sendMutation(op);
  }

  private ack(id: number, serverRecord: TradeRecord) {
    const index = this.state.pending.findIndex((op) => op.id === id);
    if (index < 0) return;

    const current = this.state.records[serverRecord.id];
    if (!current) return;

    const op = this.state.pending[index];

    // Apply the authoritative server result, then replay newer local operations.
    let next = { ...serverRecord };
    for (const newer of this.state.pending.filter((x) => x.id > op.id)) {
      if (newer.recordId === next.id) {
        next = { ...next, ...newer.fields };
      }
    }

    this.state.records[serverRecord.id] = next;
    this.state.pending = this.state.pending.filter((x) => x.id !== id);

    if (this.activeRequest === id) this.activeRequest = null;
    this.state.syncing = false;
    this.persist();
    this.emit();
    this.flush();
  }

  private stale(id: number, remote: TradeRecord) {
    const op = this.state.pending.find((x) => x.id === id);
    if (!op) return;

    const local = this.state.records[remote.id];
    if (!local) return;

    const conflicts = [...this.state.conflicts];

    for (const field of EDITABLE) {
      if (op.fields[field] === undefined) continue;

      const localValue = String(op.fields[field]);
      const remoteValue = String(remote[field]);

      if (localValue !== remoteValue) {
        if (!conflicts.some((c) =>
          c.recordId === remote.id && c.field === field
        )) {
          conflicts.push({
            recordId: remote.id,
            field,
            localValue,
            remoteValue
          });
        }
      }
    }

    this.state.records[remote.id] = {
      ...remote,
      ...local
    };
    this.state.conflicts = conflicts;
    this.state.syncing = false;
    if (this.activeRequest === id) this.activeRequest = null;
    this.persist();
    this.emit();
  }

  private remote(remote: TradeRecord) {
    const local = this.state.records[remote.id];
    if (!local) {
      this.state.records[remote.id] = remote;
      this.persist();
      this.emit();
      return;
    }

    const pendingForRecord = this.state.pending.filter(
      (op) => op.recordId === remote.id
    );

    let next = { ...remote };

    for (const op of pendingForRecord) {
      for (const field of EDITABLE) {
        if (op.fields[field] !== undefined) {
          next[field] = op.fields[field] as never;
        }
      }
    }

    this.state.records[remote.id] = next;
    this.persist();
    this.emit();
  }

  private persist() {
    const p = load();
    p.records = this.state.records;
    p.pending = this.state.pending;
    p.conflicts = this.state.conflicts;
    save(p);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
