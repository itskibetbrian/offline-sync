import { adapter } from "../adapter/serverAdapter";
import type { Conflict, LocalMutation, TradeRecord } from "../types";
import { load, save } from "../storage/persistence";
import { canonicalState } from "./state";

const EDITABLE = ["title", "notes", "status"] as const;
type EditableField = (typeof EDITABLE)[number];

const DELETED_WORD = "deleted";
const PRESENT_WORD = "present";

function deletedWord(record: TradeRecord): string {
  return record.deleted ? DELETED_WORD : PRESENT_WORD;
}

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
    // The error flag is durable: reload must show exactly what was shown
    // before it, so it is restored verbatim from the persisted snapshot.
    this.syncing = false;
    this.error = p.error === true;

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
    // Mirror reference local_edit(): syncing=true whenever online, assigned
    // explicitly and NOT via flush(). flush() early-returns when a request
    // is already in flight, which would leave the flag stale (e.g. after a
    // stale/failure for a non-head op cleared syncing while the head stayed
    // in flight, a subsequent edit must still flip syncing back to true).
    if (this.online) {
      this.syncing = true;
    }

    this.persist();
    this.emit();
    this.flush();
  }

  /**
   * Delete / restore mutations. The record stays in state with the flag set;
   * editing a deleted record changes its fields but never restores it.
   */
  remove(recordId: string) {
    this.setDeleted(recordId, true);
  }

  restoreRecord(recordId: string) {
    this.setDeleted(recordId, false);
  }

  /**
   * Local creation: temp id, version 0, full field snapshot as the op.
   * The server assigns the real id when it accepts the creation (see ack).
   */
  createRecord(): string {
    const opId = this.nextId;
    const tempId = `c${opId}`;
    const fields: LocalMutation["fields"] = {
      title: "Untitled",
      notes: "",
      status: "draft"
    };
    const op: LocalMutation = {
      id: opId,
      recordId: tempId,
      fields,
      baseVersion: 0,
      created: true
    };
    this.nextId += 1;
    this.pending.push(op);
    this.records[tempId] = {
      id: tempId,
      title: "Untitled",
      notes: "",
      status: "draft",
      version: 0,
      deleted: false
    };
    this.error = false;
    if (this.online) {
      this.syncing = true;
    }

    this.persist();
    this.emit();
    this.flush();
    return tempId;
  }

  private setDeleted(recordId: string, deleted: boolean) {
    const record = this.records[recordId];
    if (!record || record.deleted === deleted) return;

    const serverRec = this.server[recordId] ?? record;
    const op: LocalMutation = {
      id: this.nextId++,
      recordId,
      fields: {},
      baseVersion: serverRec.version,
      deleted
    };

    this.pending.push(op);
    this.records[recordId] = { ...record, deleted };
    this.error = false;
    if (this.online) {
      this.syncing = true;
    }

    this.persist();
    this.emit();
    this.flush();
  }

  /**
   * Explicit conflict resolution (rules 6-7). Creates a new mutation for the
   * chosen value when the display differs, then clears exactly that conflict.
   */
  resolveConflict(recordId: string, field: string, value: string) {
    const conflict = this.conflicts.find(
      (c) => c.recordId === recordId && c.field === field
    );
    if (!conflict) return;

    const record = this.records[recordId];
    if (!record) return;

    if (field === "deleted") {
      if (deletedWord(record) !== value) {
        if (value === DELETED_WORD) {
          this.remove(recordId);
        } else {
          this.restoreRecord(recordId);
        }
        // setDeleted() already persisted + flushed; just drop the conflict.
      }
    } else if (String(record[field as EditableField]) !== value) {
      this.create(recordId, { [field]: value } as Partial<TradeRecord>);
      // create() already persisted + flushed; just drop the conflict now.
      // No extra flush: when no new op was created the reference leaves
      // syncing untouched, and an extra flush would start a request the
      // reference never starts.
    }
    this.conflicts = this.conflicts.filter(
      (c) => !(c.recordId === recordId && c.field === field)
    );
    this.persist();
    this.emit();
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
    // NOTE: flush() intentionally leaves `error` untouched. The reference
    // only clears error on an explicit local edit (create()); acks,
    // reconnects, and boot re-emits must keep the sticky error flag or the
    // seeded sequence diverges (error hidden behind syncing, then surfacing
    // differently after the queue drains).
    this.persist();
    this.emit();
    adapter.sendMutation(op);
  }

  private ack(id: number, serverRecord: TradeRecord) {
    const index = this.pending.findIndex((op) => op.id === id);
    if (index < 0) return; // duplicate ack: idempotent (rule 9)

    const op = this.pending[index];
    // Captured before the remap below (which drops the temp key).
    const display = this.records[serverRecord.id] ?? this.records[op.recordId];
    const remaining = this.pending.filter((x) => x.id !== id);

    if (serverRecord.id !== op.recordId) {
      // Acceptance of a creation: the server assigned a real id. Every
      // reference to the temp id moves over before replay runs.
      for (const o of remaining) {
        if (o.recordId === op.recordId) {
          o.recordId = serverRecord.id;
        }
      }
      for (const c of this.conflicts) {
        if (c.recordId === op.recordId) {
          c.recordId = serverRecord.id;
        }
      }
      if (this.records[op.recordId] !== undefined) {
        delete this.records[op.recordId];
      }
    }

    // Apply authoritative server result, then replay every still-pending op
    // for the record in ID order (including ops older than the acked one).
    let next: TradeRecord = { ...serverRecord };
    for (const newer of remaining
      .filter((x) => x.recordId === serverRecord.id)
      .sort((a, b) => a.id - b.id)) {
      if (newer.deleted !== undefined) {
        next.deleted = newer.deleted;
      }
      next = { ...next, ...newer.fields };
    }

    this.records[serverRecord.id] = display ? next : { ...serverRecord };
    this.pending = remaining;
    this.server[serverRecord.id] = { ...serverRecord };

    // Drop conflicts the server acceptance resolved: acked field with no
    // remaining pending touching it and display now matching the server.
    // A delete/restore mutation acknowledges the "deleted" flag itself.
    const ackedFlag = op.deleted !== undefined;
    const stillPendingFields = new Set<string>();
    for (const r of remaining) {
      if (r.recordId !== serverRecord.id) continue;
      for (const f of Object.keys(r.fields)) stillPendingFields.add(f);
      if (r.deleted !== undefined) stillPendingFields.add("deleted");
    }
    this.conflicts = this.conflicts.filter((c) => {
      if (c.recordId !== serverRecord.id) return true;
      if (c.field === "deleted") {
        if (!ackedFlag || stillPendingFields.has("deleted")) return true;
        return next.deleted !== serverRecord.deleted;
      }
      if (!(op.fields as Record<string, unknown>)[c.field as string]) return true;
      if (stillPendingFields.has(c.field as string)) return true;
      return String(next[c.field as EditableField]) !== String(serverRecord[c.field as EditableField]);
    });

    const wasActive = this.activeRequest === id;
    if (wasActive) {
      this.activeRequest = null;
    }
    // Mirror the reference ack(): syncing is recomputed on EVERY ack as
    // online && remaining, even for out-of-order acks of non-head ops, and
    // error is left untouched. The old code only flushed when the acked op
    // was the active head, so an out-of-order ack arriving while
    // syncing==false (e.g. right after a failure) left syncing false while
    // the reference recomputed true.
    this.syncing = this.online && remaining.length > 0;
    this.persist();
    this.emit();
    if (this.activeRequest === null && this.syncing) {
      const head = [...this.pending].sort((a, b) => a.id - b.id)[0];
      if (head) {
        this.activeRequest = head.id;
        this.persist();
        this.emit();
        adapter.sendMutation(head);
      }
    }
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

    // Mirror the reference: stale_reject() sets syncing=False unconditionally.
    // Only clear the in-flight marker when it was this op's request; a stale
    // for a non-head op must not re-emit the head.
    if (this.activeRequest === id) {
      this.activeRequest = null;
    }
    this.syncing = false;
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
    // Mirror the reference: temp_failure() sets syncing=False unconditionally.
    if (this.activeRequest === id) {
      this.activeRequest = null;
    }
    this.syncing = false;
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
    let flagTouched = false;
    for (const p of pendingForRecord) {
      for (const f of Object.keys(p.fields)) pendingFields.add(f);
      if (p.deleted !== undefined) flagTouched = true;
    }

    const conflicts = [...this.conflicts];
    const next: TradeRecord = { ...incoming };

    // Replay all pending local values on top of the incoming server record.
    for (const field of EDITABLE) {
      if (pendingFields.has(field)) {
        next[field] = display[field] as never;
      }
    }
    if (flagTouched) {
      next.deleted = display.deleted;
    }

    const upsert = (field: Conflict["field"], localValue: string, remoteValue: string) => {
      if (localValue !== remoteValue) {
        if (!conflicts.some((c) => c.recordId === incoming.id && c.field === field)) {
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
    };

    for (const field of EDITABLE) {
      const localTouched = pendingFields.has(field);
      const remoteChanged =
        String(incoming[field]) !== String(prevServer[field]);

      if (localTouched && remoteChanged) {
        upsert(field, String(display[field]), String(incoming[field]));
      }
    }

    // The deleted flag merges like a field, with one extra rule: a delete on
    // one side concurrent with edits on the other yields exactly one conflict
    // on field "deleted" with the words "deleted"/"present".
    if (flagTouched && incoming.deleted !== prevServer.deleted) {
      upsert("deleted", deletedWord(display), deletedWord(incoming));
    } else if (display.deleted !== incoming.deleted && pendingForRecord.length > 0) {
      upsert("deleted", deletedWord(display), deletedWord(incoming));
    }

    return { next, conflicts };
  }

  private persist() {
    save({
      records: this.records,
      pending: this.pending,
      conflicts: this.conflicts,
      nextId: this.nextId,
      server: this.server,
      error: this.error
    });
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
