import { adapter } from "../adapter/serverAdapter";
import type { Conflict, LocalMutation, TradeRecord } from "../types";
import { load, save } from "../storage/persistence";
import { canonicalState } from "./state";

const EDITABLE = ["title", "notes", "status"] as const;
type EditableField = (typeof EDITABLE)[number];

export class SyncEngine {
  private records: Record<string, TradeRecord>;
  private pending: LocalMutation[];
  private conflicts: Conflict[];
  private server: Record<string, TradeRecord>;
  private nextId: number;
  private online: boolean;
  private syncing: boolean;
  private error: boolean;
  private listeners = new Set<() => void>();
  private activeRequest: number | null = null;

  constructor() {
    const p = load();
    this.records = p.records;
    this.pending = p.pending;
    this.conflicts = p.conflicts;
    this.server = p.server;
    this.nextId = p.nextId;
    this.online = adapter.isOnline();
    // In-flight requests never survive a reload. Re-emit the head op below.
    this.syncing = false;
    this.error = false;
    try {
      const raw = localStorage.getItem("offline-sync-v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { error?: boolean };
        if (parsed.error === true && this.pending.length > 0) this.error = true;
      }
    } catch {
      // ignore corrupt flags; defaults already apply
    }

    adapter.subscribe((event) => {
      if (event.type === "connectivity") {
        this.online = event.online;
        if (!event.online) {
          // Abort the in-flight marker. The op stays pending for retry.
          this.activeRequest = null;
          this.syncing = false;
          this.persist();
          this.emit();
        } else {
          this.persist();
          this.emit();
          this.flush();
        }
      } else if (event.type === "ack") {
        this.ack(event.mutationId, event.record);
      } else if (event.type === "stale") {
        this.stale(event.mutationId, event.record);
      } else if (event.type === "remote") {
        this.remote(event.record);
      } else if (event.type === "failure") {
        this.failure(event.mutationId);
      }
    });

    this.flush();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState() {
    return canonicalState({
      records: this.records,
      pending: this.pending,
      conflicts: this.conflicts,
      online: this.online,
      syncing: this.syncing,
      error: this.error
    });
  }

  /** Public local edit. Never touches conflicts (rule 8). */
  create(recordId: string, fields: Partial<TradeRecord>) {
    const record = this.records[recordId];
    if (!record) throw new Error("Unknown record");

    const clean: LocalMutation["fields"] = {};
    for (const field of EDITABLE) {
      if (fields[field] !== undefined && fields[field] !== record[field]) {
        clean[field] = fields[field] as never;
      }
    }
    if (Object.keys(clean).length === 0) return;

    const serverRec = this.server[recordId] ?? record;
    const op: LocalMutation = {
      id: this.nextId++,
      recordId,
      fields: clean,
      baseVersion: serverRec.version,
      baseValues: {
        title: String(serverRec.title),
        notes: String(serverRec.notes),
        status: String(serverRec.status)
      }
    };

    this.pending.push(op);
    this.records[recordId] = { ...record, ...clean };
    this.error = false;

    this.persist();
    this.emit();
    this.flush();
  }

  /**
   * Explicit conflict resolution (rules 6-7). Creates a new mutation for the
   * chosen value when the display differs, then clears exactly that conflict.
   */
  resolveConflict(recordId: string, field: EditableField, value: string) {
    const conflict = this.conflicts.find(
      (c) => c.recordId === recordId && c.field === field
    );
    if (!conflict) return;

    const record = this.records[recordId];
    if (!record) return;

    if (String(record[field]) !== value) {
      this.create(recordId, { [field]: value } as Partial<TradeRecord>);
      // create() already persisted + flushed; just drop the conflict now.
    }
    this.conflicts = this.conflicts.filter(
      (c) => !(c.recordId === recordId && c.field === field)
    );
    this.persist();
    this.emit();
    this.flush();
  }

  private flush() {
    if (!this.online || this.activeRequest !== null) return;

    const op = [...this.pending].sort((a, b) => a.id - b.id)[0];
    if (!op) {
      this.syncing = false;
      this.emit();
      return;
    }

    this.activeRequest = op.id;
    this.syncing = true;
    this.error = false;
    this.persist();
    this.emit();
    adapter.sendMutation(op);
  }

  private ack(id: number, serverRecord: TradeRecord) {
    const index = this.pending.findIndex((op) => op.id === id);
    if (index < 0) return; // duplicate ack: idempotent (rule 9)

    const op = this.pending[index];
    const display = this.records[serverRecord.id];
    const remaining = this.pending.filter((x) => x.id !== id);

    // Apply authoritative server result, then replay newer local ops (rule 10).
    let next: TradeRecord = { ...serverRecord };
    for (const newer of remaining
      .filter((x) => x.recordId === serverRecord.id)
      .sort((a, b) => a.id - b.id)) {
      next = { ...next, ...newer.fields };
    }

    this.records[serverRecord.id] = display ? next : { ...serverRecord };
    this.pending = remaining;
    this.server[serverRecord.id] = { ...serverRecord };

    // Drop conflicts the server acceptance resolved: acked field with no
    // remaining pending touching it and display now matching the server.
    const stillPendingFields = new Set<string>();
    for (const r of remaining) {
      if (r.recordId !== serverRecord.id) continue;
      for (const f of Object.keys(r.fields)) stillPendingFields.add(f);
    }
    this.conflicts = this.conflicts.filter((c) => {
      if (c.recordId !== serverRecord.id) return true;
      if (!(op.fields as Record<string, unknown>)[c.field as string]) return true;
      if (stillPendingFields.has(c.field as string)) return true;
      return String(next[c.field as EditableField]) !== String(serverRecord[c.field as EditableField]);
    });

    const wasActive = this.activeRequest === id;
    if (wasActive) {
      this.activeRequest = null;
      this.syncing = false;
    }
    this.persist();
    this.emit();
    if (wasActive) this.flush();
  }

  private stale(id: number, remote: TradeRecord) {
    const op = this.pending.find((x) => x.id === id);
    if (!op) return; // unknown op: never overwrite newer state (rule 10)

    const display = this.records[remote.id];
    if (!display) {
      this.server[remote.id] = { ...remote };
      this.persist();
      this.emit();
      return;
    }

    const prevServer = this.server[remote.id] ?? display;
    const { next, conflicts } = this.reconcile(display, prevServer, remote);

    this.records[remote.id] = next;
    this.server[remote.id] = { ...remote };
    this.conflicts = conflicts;

    if (this.activeRequest === id) {
      this.activeRequest = null;
      this.syncing = false;
    }
    this.persist();
    this.emit();
  }

  private remote(remote: TradeRecord) {
    const display = this.records[remote.id];
    if (!display) {
      this.records[remote.id] = { ...remote };
      this.server[remote.id] = { ...remote };
      this.persist();
      this.emit();
      return;
    }

    const prevServer = this.server[remote.id] ?? display;
    const { next, conflicts } = this.reconcile(display, prevServer, remote);

    this.records[remote.id] = next;
    this.server[remote.id] = { ...remote };
    this.conflicts = conflicts;
    this.persist();
    this.emit();
  }

  private failure(id: number) {
    const op = this.pending.find((x) => x.id === id);
    if (!op) return; // duplicate/unknown failure: ignore
    // Temporary failure leaves the op pending (rule 11).
    if (this.activeRequest === id) {
      this.activeRequest = null;
      this.syncing = false;
    }
    this.error = true;
    this.persist();
    this.emit();
  }

  /**
   * Three-way field merge. Local = union of pending fields (kept in display),
   * remote change = server field differs from previous server snapshot.
   * Same-field disagreement with differing values becomes a conflict.
   */
  private reconcile(
    display: TradeRecord,
    prevServer: TradeRecord,
    incoming: TradeRecord
  ): { next: TradeRecord; conflicts: Conflict[] } {
    const pendingForRecord = this.pending.filter((x) => x.recordId === incoming.id);
    const pendingFields = new Set<string>();
    for (const p of pendingForRecord) {
      for (const f of Object.keys(p.fields)) pendingFields.add(f);
    }

    const conflicts = [...this.conflicts];
    const next: TradeRecord = { ...incoming };

    // Replay all pending local values on top of the incoming server record.
    for (const field of EDITABLE) {
      if (pendingFields.has(field)) {
        next[field] = display[field] as never;
      }
    }

    for (const field of EDITABLE) {
      const localTouched = pendingFields.has(field);
      const remoteChanged =
        String(incoming[field]) !== String(prevServer[field]);
      const key = `${incoming.id}:${field}`;
      void key;

      if (localTouched && remoteChanged) {
        const localValue = String(display[field]);
        const remoteValue = String(incoming[field]);
        if (localValue !== remoteValue) {
          if (
            !conflicts.some((c) => c.recordId === incoming.id && c.field === field)
          ) {
            conflicts.push({ recordId: incoming.id, field, localValue, remoteValue });
          } else {
            // Refresh values if either side moved again.
            for (const c of conflicts) {
              if (c.recordId === incoming.id && c.field === field) {
                c.localValue = localValue;
                c.remoteValue = remoteValue;
              }
            }
          }
        } else {
          // Converged to the same value: no disagreement remains.
          for (let i = conflicts.length - 1; i >= 0; i--) {
            if (conflicts[i].recordId === incoming.id && conflicts[i].field === field) {
              conflicts.splice(i, 1);
            }
          }
        }
      }
    }

    return { next, conflicts };
  }

  private persist() {
    save({
      records: this.records,
      pending: this.pending,
      conflicts: this.conflicts,
      nextId: this.nextId,
      server: this.server
    });
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
