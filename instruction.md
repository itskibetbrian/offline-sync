# Offline sync engine

Construct a small web application which stores editable records and synchronises any local modifications via the given server adapter. The server side acts in an adversarial manner by sending responses with delays, duplicates, and in a different order, rejecting writes because they are deemed stale, causing requests to fail and leading to a loss of connectivity. The grader causes all these issues through the adapter. Local edits must never be lost, have to survive reloads, and must be reconciled with the server without any silent overwrites.

## Records and mutations

Each record includes three fields which can be edited by the user: `title`, `notes`, and `status`. The `status` field can have one of the values `draft`, `active`, or `complete`. The server also assigns an `id` and an authoritative integer `version` which increases with each accepted write.

Each local edit is assigned a mutation with an integer ID that increases monotonically and is permanently saved before it is considered to be pending. Mutations that are pending persist through a browser reload. Every mutation includes a field called `baseVersion`, which is the server version seen at the time the edit was made; if an edit makes no changes then no mutation is created.

Seed data on a fresh profile:

- r1: title "Steel shipment", notes "40 tonnes", status "draft", version 1
- r2: title "Copper shipment", notes "25 tonnes", status "active", version 1
- r3: title "Timber load", notes "12 pallets", status "complete", version 1

## Sync rules

The grader models synchronisation as a deterministic state machine and compares your application on an event-by-event basis. For each mutation it reads `{ id, recordId, fields, baseVersion }`, where the `fields` list contains only the editable fields that have changed, are arranged alphabetically, and the `pendingOperations` are given in ascending order of their IDs.

Next to the display record the client keeps a snapshot of the last known server record and the remote and stale events are combined against that snapshot, field by field:

1. **Fields that have not been touched are merged.** If a local edit is made to a field which the remote side has not altered, then that edit is retained and merged.
2. **When the same field is edited both locally and remotely there is one unresolved conflict, except when both sides have the same value.**
3. **Fields are independent.** Changes to different fields in a single record combine on their own.
4. **Records that are unknown are stored.** A remote record with an unknown ID is stored without any changes.
5. **Conflict shape.** A conflict is precisely defined as `{ recordId, field, localValue, remoteValue }` and it contains both the display value and the incoming server value.
6. **Conflict order.** The conflicts are sorted by recordId and then by field name.
7. **Conflicts continue to exist.** A conflict remains until the user resolves it themselves. It cannot be cleared silently by means of an edit or a refresh. The only exception is server acceptance (see rule 10).
8. **Resolution.** When resolving a conflict, a new local mutation is created with the selected value; however, if the display already has that value, then no mutation is necessary and only the conflict is removed. If there is no conflict in the field being resolved, then nothing happens.
9. **Idempotent acknowledgements.** If a duplicate acknowledgement is received it has no effect; any acknowledgement, stale rejection, or failure that refers to an operation ID which is unknown is ignored.
10. **Ack acceptance.** When an ack is applied, all the pending edits for that record are replayed over it in the order of their IDs, including those which are older than the operation that has been acknowledged. Nothing is ever lost. Furthermore, the ack removes a conflict from a field that has been acknowledged if no further pending operation affects that field and the display now agrees with the server. After this, syncing is once again calculated as being online with work still remaining.
11. **Stale and failure.** When a stale reject occurs, the operation remains pending and the same three-way merge is carried out. If the server has not altered a particular field, then there is no conflict associated with that field. If both versions end up with the same value, the conflict for that field is eliminated. The reject causes the in-flight marker to be cleared. A temporary failure also keeps the operation pending, clears the in-flight marker, and indicates that an error has occurred on the client's side.
12. **Sticky error.** The error flag remains set even after acknowledgements, reconnects, and reloads. It is only cleared by a new local edit.
13. **Reconnect.** When you go offline the in-flight marker is removed but the pending work is retained; when you reconnect the head operation is retried.
14. **Reload.** When reload is performed, the records, the conflicts, the pending projection, the next mutation ID, the server snapshot, and the error flag all remain unchanged. The in-flight marker is now calculated as online with work still remaining. Since adapter connectivity is not durable, the grader reasserts it after each reload.
15. **No deletes.** Deletes are not included.

The status is determined by the first matching case: conflict if there is a conflict; syncing if a request is currently in progress; offline if the adapter indicates that it is offline; error if there is a retryable failure; and online in all other cases.

## App interface

The function `window.__OFFLINE_SYNC_STATE__()` is exposed and returns a value consisting of `{ records, pendingOperations, syncStatus, conflicts }` synchronously. The records are indexed by ID and include exactly the properties `id`, `title`, `notes`, `status`, and `version`. The status is one of the following: `online`, `offline`, `syncing`, `conflict`, or `error`. The conflicts are sorted as specified in rule 6, and the pending operations are projected as explained above.

The application also provides `window.__OFFLINE_SYNC_ADAPTER__` together with the methods `setOnline(bool)`, `ack(mutationId, record)`, `stale(mutationId, record)`, `remote(record)`, and `failure(mutationId)` in order to allow deterministic testing, as well as `window.__OFFLINE_SYNC_READY__`, which takes the value true when the application has completed its initialization. The user interface must let a person edit any record, display the status and the pending tasks, and resolve each conflict by making an explicit choice between keeping the local version or keeping the remote version. The `sync-status` element displays the current status string exactly as it is. The grader operates the UI using only these stable hooks: `select-record-<id>`, `record-title`, `record-notes`, `record-status`, `save-record`, `sync-status`, `keep-local-<recordId>-<field>`, and `keep-remote-<recordId>-<field>`.

## Delivery

A browser reload is performed in the first instance, after which the grader waits for the ready flag, re-establishes connectivity, and then reads the state once more. The grading process operates on the production build within an actual browser, carrying out a series of scripted actions including edits, remote updates, stale rejects, duplicate and out-of-order acknowledgements, failures, reconnects, resolutions, reloads, and one long sequence generated with a seeded random number. An independent reference model carries out the same steps and, after each one, the records, versions, pending items, conflicts, and status must be identical. There are no restrictions on the framework, storage, or internal design.

You should work in the /workspace directory, and running `npm run build` in that directory must result in the creation of /workspace/dist, with /workspace/dist/index.html serving as the entry point since it is the one that the grader serves; the source files are located in /workspace/src.

You have 9000 seconds to complete this task. Do not cheat by using online solutions or hints specific to this task.
