# Offline sync engine

Build a small web app keeping editable records, syncing local mutations through the given server adapter. The server side acts adversarially: responses arrive delayed, duplicated and reordered, writes are rejected as stale, requests fail and connectivity drops. The grader drives all of this through the adapter. Local edits must never be lost, must survive reloads, and must reconcile with the server without silent overwrites.

## Records and mutations

Each record has three user-editable fields: `title`, `notes`, `status`, the last one of `draft`, `active` or `complete`. The server adds `id` and an authoritative integer `version` which increases with each accepted write.

Each local edit becomes a mutation with a monotonically increasing integer ID, durably persisted before it counts as pending; pending mutations survive reloads. Every mutation records `baseVersion`, the server version visible when the edit was made; an edit which changes nothing creates no mutation. A created record carries a temporary client id, starts at version 0 with `baseVersion` 0, and its creation mutation holds all three field values.

Every record also carries a `deleted` flag (false for seeds); deleted records stay in state with the flag set.

Seed data on a fresh profile:

- r1: title "Steel shipment", notes "40 tonnes", status "draft", version 1
- r2: title "Copper shipment", notes "25 tonnes", status "active", version 1
- r3: title "Timber load", notes "12 pallets", status "complete", version 1

## Sync rules

The grader models sync as a deterministic state machine and compares your app against it event by event. Per mutation it reads `{ id, recordId, fields, baseVersion }`, `fields` listing only changed editable fields alphabetically, `pendingOperations` in ascending ID order. Delete/restore mutations carry empty `fields` plus `deleted` true/false; creations carry `created` true.

The client keeps a snapshot of the last known server record next to the display record; remote and stale events merge against that snapshot, field by field:

1. **Untouched fields merge.** A local edit to a field the remote side did not touch is kept and merged.
2. **Same-field edits conflict.** Local and remote edits to the same field produce one unresolved conflict, unless both sides hold the same value.
3. **Fields are independent.** Edits to different fields on one record merge independently.
4. **Unknown records are stored.** A remote record with an unknown ID is stored as-is.
5. **Conflict shape.** A conflict is exactly `{ recordId, field, localValue, remoteValue }`, holding the display value and the incoming server value.
6. **Conflict order.** Conflicts sort by `recordId`, then field name.
7. **Conflicts persist.** A conflict stays until the user explicitly resolves it. No edit or refresh clears it silently. Server acceptance is the only exception (see rule 10).
8. **Resolution.** Resolving writes a new local mutation carrying the chosen value. If the display already holds that value, no mutation is needed. Only that conflict is removed. Resolving a field with no conflict does nothing.
9. **Idempotent acks.** A duplicate ack changes nothing. An ack, stale reject, or failure naming an unknown operation ID is ignored.
10. **Ack acceptance.** An ack applies the authoritative server record, then replays every still-pending edit for that record over it in ID order, including edits older than the acked operation. The ack also drops a conflict on an acknowledged field when nothing remaining touches it and the display matches the server; a delete/restore mutation acknowledges the `deleted` flag itself. Afterwards `syncing` is online with work remaining.
11. **Stale and failure.** A stale reject leaves the operation pending and runs the same three-way merge. A field the server never changed produces no conflict. Equal values on both sides remove the conflict. The `deleted` flag is exempt here and always falls under rule 16. The reject clears the in-flight marker. A temporary failure keeps the operation pending, clears the marker, and marks the client errored.
12. **Sticky error.** The error flag survives acks, reconnects, and reloads. Only a new local edit clears it.
13. **Reconnect.** Going offline drops the in-flight marker but keeps pending work. Going back online retries the head operation.
14. **Reload.** Reload restores records, conflicts, pending projection, next mutation ID, server snapshot, and error flag unchanged. The marker is recomputed as online with work remaining. Adapter connectivity is not durable, so the grader re-asserts it after each reload.
15. **Deletion.** Deleting appends a delete mutation setting the flag; restoring clears it. Editing a deleted record alters fields but leaves it deleted.
16. **Delete clashes.** The merge compares the display record's `deleted` flag, taken before pending work is replayed, against the incoming record's flag. Where the flag was both touched by a pending delete or restore and changed on the server, rule 2 applies: differing words keep or refresh the conflict, identical words remove it. Any other disagreement — a delete racing an edit, or pending flag work meeting an incoming record still carrying the old flag — yields exactly one conflict on field `"deleted"`: `"deleted"` for the side which deleted, `"present"` for the other. Agreement outside the first case leaves an existing conflict untouched. Where nothing at all is pending for the record, an incoming flag change merges silently with no conflict. Choosing `"deleted"` appends a delete mutation unless already deleted; choosing `"present"` appends a restore unless already present.
17. **Creation.** The create control appends a record with a temporary client id at version 0 and default field values. The temporary id is the letter `c` followed by the mutation id, so the first creation on a fresh profile is `c1`; the defaults are title `"Untitled"`, notes `""`, and status `"draft"`. It can be edited, deleted, and restored while it waits; its operations wait behind the creation, since the server never acknowledges, rejects, or pushes a record it has not accepted yet.
18. **Acceptance.** Accepting a creation assigns a fresh real id and version 1, taking values and flag as displayed. Every reference to the temporary id moves over: the record, all remaining pending operations for it, and any conflicts naming it. Later operations use the real id.

The status is determined by the first matching case: it is conflict if there is a conflict; syncing if a request is currently in progress; offline if the adapter indicates that it is offline; error if there is a retryable failure; and online in all other cases.

## App interface

Expose `window.__OFFLINE_SYNC_STATE__()`. It returns `{ records, pendingOperations, syncStatus, conflicts }` synchronously. Records are keyed by ID and hold exactly the properties `id`, `title`, `notes`, `status`, `version`, and `deleted`. The status is one of `online`, `offline`, `syncing`, `conflict`, `error`. The conflicts are sorted as in rule 6; pending operations are projected as above.

The app also exposes `window.__OFFLINE_SYNC_ADAPTER__` with the functions `setOnline(bool)`, `ack(mutationId, record)`, `stale(mutationId, record)`, `remote(record)`, and `failure(mutationId)` for deterministic driving, plus `window.__OFFLINE_SYNC_READY__`, true once the app has initialized. The UI must let a person edit, delete, restore, and create records, show status and pending work, and resolve each conflict with an explicit keep-local or keep-remote choice. The `sync-status` element shows exactly the current status string. Status is edited through a `<select>` offering at least the options `draft`, `active`, and `complete`. Every hook below is a `data-testid` value the grader locates elements through: `create-record`, `select-record-<id>`, `record-title`, `record-notes`, `record-status`, `save-record`, `sync-status`, `keep-local-<recordId>-<field>`, `keep-remote-<recordId>-<field>`, `delete-record-<id>`, and `restore-record-<id>`.

## Delivery

After a reload the grader waits for the ready flag, re-asserts connectivity, and reads state again. Grading serves the production build in a real browser and steps scripted sequences through it: edits, creates, deletes, restores, remote updates, stale rejects, duplicate and out-of-order acks, failures, reconnects, resolutions, reloads, and one long seeded-random sequence. An independent reference model takes the same steps; records, versions, pending, conflicts, and status must match after every step. Framework, storage, and internal design are unrestricted.

Work in `/workspace`: running `npm run build` there must produce `/workspace/dist` with `/workspace/dist/index.html` as the entry point, which the grader serves. Sources live under `/workspace/src`.

You have 9000 seconds to complete this task. Do not cheat by using online solutions or hints specific to this task.
